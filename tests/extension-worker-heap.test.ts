import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {join} from 'node:path'
import {describe,expect,it} from 'vitest'
import {parentWorkerHeapOverrides} from '../src/extension-worker.js'
import {buildExtensionWorkerArtifacts} from './helpers/extension-worker-build.js'
const run=promisify(execFile)

describe('parent V8 heap override admission',()=>{
  it('recognizes accepted heap flag spellings but not words embedded in quoted file paths',()=>{
    expect(parentWorkerHeapOverrides(['--max_old_space_size=128','--max-semi-space-size','16'],undefined)).toEqual(['--max-old-space-size','--max-semi-space-size'])
    expect(parentWorkerHeapOverrides([], '"--max-old-space-size=128" --max_heap_size=256')).toEqual(['--max-old-space-size','--max-heap-size'])
    expect(parentWorkerHeapOverrides([], '--require "C:/tools/--max-old-space-size=128 helper.cjs" --require "C:/tools/path --max-old-space-size=128.cjs"')).toEqual([])
  })
  it('starts a bounded worker without overrides, and refuses CLI or NODE_OPTIONS overrides before host import',async()=>{
    const artifacts=await buildExtensionWorkerArtifacts()
    const runner=join(process.cwd(),'tests','supervised','extension-worker-heap-runner.mjs')
    const variants=[
      {args:[] as string[],options:undefined,refused:false},
      {args:['--max-old-space-size=128'],options:undefined,refused:true},
      {args:['--max_old_space_size=128'],options:undefined,refused:true},
      {args:['--max-semi-space-size=16'],options:undefined,refused:true},
      {args:['--max-heap-size=128'],options:undefined,refused:true},
      {args:[],options:'--max-old-space-size=128',refused:true},
      {args:[],options:'--max_semi_space_size=16',refused:true},
    ]
    if(process.allowedNodeEnvironmentFlags.has('--max-old-space-size-percentage')){
      variants.push({args:['--max-old-space-size-percentage=50'],options:undefined,refused:true},{args:[],options:'--max-old-space-size-percentage=50',refused:true})
    }
    for(const variant of variants){
      const env={...process.env}
      if(variant.options===undefined)delete env.NODE_OPTIONS
      else env.NODE_OPTIONS=variant.options
      const result=await run(process.execPath,[...variant.args,runner,artifacts.runtimeEntry,artifacts.supervisorBundle],{env,timeout:15_000,windowsHide:true})
      const report=JSON.parse(result.stdout) as {errorCode?:string;heap?:number;imported:boolean;budget:number;threads:number}
      expect(report.budget).toBe(0);expect(report.threads).toBe(0)
      if(variant.refused){expect(report.errorCode).toBe('extension_worker_heap_override');expect(report.imported).toBe(false)}
      else{expect(report.errorCode).toBeUndefined();expect(report.imported).toBe(true);expect(report.heap).toBeLessThan(80*1024*1024)}
    }
  })
})
