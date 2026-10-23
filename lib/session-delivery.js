import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// One queue owns session selection and persona acknowledgement for all channels.
export function createSessionDelivery({controller,dshHome,cwd,sessionId,config,persona,isBusy=()=>false,now=Date.now,log=()=>{},onSession=()=>{}}) {
  const file=path.join(dshHome,'whale-session.json')
  let state={id:sessionId,startedAt:now()},ready=false,tail=Promise.resolve(),lastDelivered=0
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'))
    if(typeof saved.id!=='string'||!saved.id||!Number.isFinite(saved.startedAt)||saved.startedAt<0)throw Error('invalid state')
    state=saved
  } catch(e) { if(e.code!=='ENOENT')throw Error('会话状态损坏，请检查 whale-session.json，避免误建会话') }
  onSession(state.id)
  lastDelivered=Number.isFinite(state.deliveredAt)?state.deliveredAt:0
  function save(next) {
    fs.mkdirSync(dshHome,{recursive:true})
    const tmp=file+'.'+crypto.randomUUID()+'.tmp'
    try {fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,file)} finally {fs.rmSync(tmp,{force:true})}
  }
  return {
    send(request,signal) {
      const job=tail.then(async()=>{
        signal?.throwIfAborted()
        const cfg=config(),days=Number(cfg.sessionRotateDays??0),once=cfg.personaOncePerSession===true
        const persist=once||(Number.isFinite(days)&&days>0)
        const rotating=Number.isFinite(days)&&days>0&&now()-state.startedAt>=days*86400000&&now()-lastDelivered>=8*60000&&!isBusy()
        const next=rotating?{id:crypto.randomUUID(),startedAt:now(),rotatedFrom:state.id}:state
        let created = null
        if(!ready||rotating) {
          try {created = await controller.create({sessionId:next.id,cwd})}
          catch(e) {if(rotating)throw e;log('沿用现有会话；若投递失败将保留重试状态')}
        }
        // 2026-10-24 修（审查报告第 3 条）：宿主会话被删掉重建时，
        //   whale-session.json 里的 personaHash / deliveredAt 还留着 ✗
        //   → 新会话第一轮会【没有人设、没有日记恢复指引】✗（无声无息）
        // 宿主的 create() 若明确告诉我们"这是新建的空会话"，就把两个标记清掉 ✓
        // （拿不到明确信号时不猜 ✗ —— 宁可多注入一次人设 ✓）
        const isFresh = created === true || (created && typeof created === 'object' && (created.created === true || created.fresh === true))
        if(isFresh && (next.personaHash || next.deliveredAt)) {
          // 注意：要清 next ✗（下面 state=next 会把 state 覆盖掉）
          delete next.personaHash; delete next.deliveredAt
          if(state!==next){delete state.personaHash; delete state.deliveredAt}
          log('宿主会话是新建的 → 重置人设注入与日记恢复标记，下一轮重新注入')
        }
        if(persist)save(next)
        if(rotating)log(`会话轮换：${state.id} → ${next.id}；旧会话保留`)
        state=next;ready=true;onSession(state.id)
        signal?.throwIfAborted()
        const block=persona(),fingerprint=crypto.createHash('sha256').update(block).digest('hex')
        const include=!once||state.personaHash!==fingerprint
        const reminder=`人设依据：${path.join(process.env.USERPROFILE||process.env.HOME||'.','.bili-ai/persona.md')}；上下文缺失时重读。`
        const diary=`先读本地日记恢复记忆：${path.join(dshHome,'whale-diary.md')} 和 ${path.join(dshHome,'whale-diary-private.md')}；不要将旧会话未确认事项当成已完成。`
        const prefix=[include?block:reminder,...(!state.deliveredAt?[diary]:[])].filter(Boolean).join('\n')
        const content=[...(request.content??[])]
        if(content[0]?.type==='text')content[0]={...content[0],text:prefix+'\n'+content[0].text}
        else content.unshift({type:'text',text:prefix})
        try {await controller.prompt({...request,sessionId:state.id,content},signal)}
        catch(e) {ready=false;throw e}
        lastDelivered=now()
        state={...state,personaHash:fingerprint,deliveredAt:lastDelivered}
        // Delivery succeeded: persistence failure must not make callers retry it.
        if(persist)try {save(state)} catch(e){log('会话已投递，但保存人设标记失败：'+e.message)}
      })
      tail=job.catch(()=>{})
      return job
    },
  }
}
