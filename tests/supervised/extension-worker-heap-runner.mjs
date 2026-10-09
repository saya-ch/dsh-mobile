import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

const [runtimeEntry,supervisorBundle]=process.argv.slice(2)
if(runtimeEntry===undefined||supervisorBundle===undefined)throw new Error('worker artifact arguments are missing')
const {ExtensionWorkerHost,ExtensionWorkerBudget,activeWorkerCount}=await import(pathToFileURL(supervisorBundle).href)
const root=await mkdtemp(join(tmpdir(),'dsh-worker-heap-parent-'))
const marker=join(root,'imported')
let host
try{
  await writeFile(join(root,'host.mjs'),`import {writeFile} from 'node:fs/promises'; import {getHeapStatistics} from 'node:v8'
    await writeFile(${JSON.stringify(marker)},'executed');export default api=>{api.action('heap',{run:()=>getHeapStatistics().heap_size_limit})}`)
  const budget=new ExtensionWorkerBudget(1)
  let errorCode
  let heap
  try{
    host=new ExtensionWorkerHost({workerModule:runtimeEntry,hostFile:join(root,'host.mjs'),manifest:{schemaVersion:1,id:'heap',name:'heap',version:'1'},generation:'same',budget,limits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:4},logger:{debug(){},info(){},warn(){},error(){}}})
    await host.activate()
    heap=JSON.parse((await host.invoke('heap',{}, {signal:new AbortController().signal,deviceId:'device'})).bytes.toString())
  }catch(error){errorCode=error?.code??'unexpected'}
  if(host!==undefined)await host.dispose()
  let imported=false
  try{imported=(await readFile(marker,'utf8'))==='executed'}catch(error){if(error?.code!=='ENOENT')throw error}
  process.stdout.write(JSON.stringify({errorCode,heap,imported,budget:budget.current,threads:activeWorkerCount.current}))
}finally{
  if(host!==undefined)await host.dispose()
  await rm(root,{recursive:true,force:true})
}
