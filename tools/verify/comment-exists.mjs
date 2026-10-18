// 复核一条评论到底有没有"公开"出去。三层：
//   [a] 视频页 HTML（服务端状态，匿名）
//   [b] reply/reply 匿名请求  ← 公开世界的视角
//   [c] reply/reply 带登录态  ← 自己的视角（对照用）
//
// 为什么要 [b] 和 [c] 对照：
//   B 站会对部分评论"假成功"——接口回 code=0、评论也确实进了库，
//   但公开接口查不到（俗称被阿瓦隆吞了，见 NOTES 8.5）。
//   只看匿名会误判成"没发出去"，只看登录态会误判成"发成功了"，两个一起看才有结论：
//     匿名✓ + 登录态✓ → 真公开
//     匿名✗ + 登录态✓ → 仅自己可见 / 审核中（state 通常不是 0）
//     匿名✗ + 登录态✗ → 真的不存在
//
// 用法: node comment-exists.mjs <rpid> <aid> [bvid]
import fs from 'node:fs'
import path from 'node:path'

const RPID = process.argv[2]
const AID = process.argv[3]
const BVID = process.argv[4]
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = BVID ? `https://www.bilibili.com/video/${BVID}/` : 'https://www.bilibili.com/'

if (!RPID || !AID) { console.error('用法: node comment-exists.mjs <rpid> <aid> [bvid]'); process.exit(2) }

const a = BVID ? await fetch(`https://www.bilibili.com/video/${BVID}/`, {
  headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', 'accept-language': 'zh-CN,zh;q=0.9' },
}) : null
if (a) {
  const html = await a.text()
  console.log(`[a] 视频页 HTTP ${a.status}，${html.length} 字节`)
  for (const needle of [RPID, ...process.argv.slice(3)]) {
    const n = html.split(needle).length - 1
    console.log(`    包含 "${needle}": ${n > 0 ? `是（${n} 处）` : '否'}`)
  }
} else {
  console.log('[a] 没给 bvid，跳过视频页检查')
}

const b = await fetch(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${AID}&root=${RPID}&pn=1&ps=20`, {
  headers: { 'user-agent': UA, referer: REF },
})
const bd = await b.json()
console.log(`\n[b] reply/reply HTTP ${b.status} code=${bd.code} message=${bd.message}`)
if (bd.code === 0) {
  const root = bd.data?.root
  if (root) {
    console.log(`    根评论存在 ✓  ${root.member?.uname}: ${String(root.content?.message ?? '').slice(0, 90)}`)
    console.log(`    rpid=${root.rpid}  ctime=${new Date(root.ctime * 1000).toLocaleString('zh-CN')}`)
    const members = root.content?.members ?? []
    console.log(`    @解析: ${members.length ? members.map((m) => `${m.uname}(mid ${m.mid})`).join(', ') : '该接口未回报 members'}`)
  } else {
    console.log('    code=0 但没返回 root（可能该接口不再回根评论）')
  }
}

// —— [c] 带登录态的对照 ——
let verdict = '❓ 结论不确定'
try {
  const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
  const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
  const c = await fetch(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${AID}&root=${RPID}&pn=1&ps=20`, {
    headers: { 'user-agent': UA, referer: REF, cookie },
  })
  const cd = await c.json()
  const croot = cd.data?.root
  console.log(`\n[c] 带登录态对照 HTTP ${c.status} code=${cd.code}`)
  if (croot) {
    console.log(`    登录态可见 ✓  state=${croot.state}（0=正常公开；实测 17=仅自己可见/审核中）`)
    console.log(`    作者 ${croot.member?.uname} (mid ${croot.mid})  正文: ${String(croot.content?.message ?? '').slice(0, 60)}`)
  } else {
    console.log('    登录态也查不到 —— 这条评论多半真的不存在/已被删')
  }

  const anon = bd.code === 0 && !!bd.data?.root
  verdict = anon && croot
    ? '✅ 真公开：匿名和登录态都能看到'
    : (!anon && croot)
      ? '⚠️ 仅自己可见 / 审核中：登录态能看到、匿名看不到（被"假成功"吞了，别当成发成功）'
      : (!anon && !croot)
        ? '❌ 不存在：两种身份都查不到（没发出去，或已被删除）'
        : '⚠️ 异常：匿名能看到但登录态看不到（极少见，可能接口缓存，稍后重查）'
} catch (e) {
  console.log(`\n[c] 跳过对照：${e.message}`)
  verdict = (bd.code === 0 && bd.data?.root) ? '⚠️ 匿名可见（未做登录态对照，存疑）' : '❓ 未做对照，结论不确定'
}
console.log(`\n=== 结论：${verdict} ===`)
