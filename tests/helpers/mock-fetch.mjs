import fs from 'node:fs'
globalThis.fetch = async (url, opts = {}) => {
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({url:String(url),method:opts.method ?? 'GET'})+'\n')
  let data
  if (String(url).includes('/nav')) data={code:0,data:{isLogin:true,mid:111,uname:'test-account'}}
  else if(String(url).includes('/x/relation'))data={code:0,data:{attribute:6}}
  else if(String(url).includes('/send_msg'))data={code:0,data:{}}
  else throw Error('Network blocked by test: '+url)
  return {status:200,ok:true,json:async()=>data}
}
