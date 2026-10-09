import { Context, type Message } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMobileFileLogger } from '../src/file-logger.js'

const contexts:Context[]=[]
const directories:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const context of contexts.splice(0))await context.fiber.dispose();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true})})
async function fixture():Promise<{root:string;context:Context}>{
  const root=await mkdtemp(join(tmpdir(),'dsh-file-log-'));directories.push(root)
  const context=new Context();contexts.push(context)
  return {root,context}
}

describe('private mobile file logger',()=>{
  it('opens before returning, appends only plugin records and disposes after file close',async()=>{
    const {root,context}=await fixture()
    let acquired:WriteStream|undefined
    const file=await installMobileFileLogger(context,root,{createStream(handle){acquired=handle.createWriteStream({autoClose:true,encoding:'utf8'});return acquired}})
    expect((await lstat(file)).isFile()).toBe(true)
    context.logger('dsh-mobile').info('hello %s','world')
    context.logger('unrelated').info('not in this file')
    await context.fiber.dispose()
    expect(acquired?.closed).toBe(true)
    const lines=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {logger:string;message:string})
    expect(lines).toEqual([expect.objectContaining({logger:'dsh-mobile',message:expect.stringContaining('hello world')})])
    if(process.platform!=='win32')expect((await lstat(file)).mode&0o777).toBe(0o600)
  })
  it('rotates a large regular file without modifying unrelated files',async()=>{
    const {root,context}=await fixture();const logs=join(root,'logs');await mkdir(logs)
    const file=join(logs,'dsh-mobile.log');await writeFile(file,'x'.repeat(5*1024*1024))
    await writeFile(file+'.1','previous')
    await installMobileFileLogger(context,root)
    context.logger('dsh-mobile').info('new file');await context.fiber.dispose()
    expect((await lstat(file+'.1')).size).toBe(5*1024*1024)
    expect(await readFile(file,'utf8')).toContain('new file')
  })
  it('refuses a non-file rotation target and preserves both generations',async()=>{
    const {root,context}=await fixture();const logs=join(root,'logs');await mkdir(logs)
    const file=join(logs,'dsh-mobile.log');await writeFile(file,'x'.repeat(5*1024*1024))
    await mkdir(file+'.1');await writeFile(join(file+'.1','sentinel'),'unchanged')
    await expect(installMobileFileLogger(context,root)).rejects.toThrow('mobile_log_target_invalid')
    expect((await lstat(file)).size).toBe(5*1024*1024)
    expect(await readFile(join(file+'.1','sentinel'),'utf8')).toBe('unchanged')
  })
  it('refuses linked log parents and non-regular leaves without claiming a file is available',async()=>{
    const {root,context}=await fixture()
    const outside=await mkdtemp(join(tmpdir(),'dsh-log-outside-'));directories.push(outside)
    await writeFile(join(outside,'sentinel'),'unchanged')
    await symlink(outside,join(root,'logs'),process.platform==='win32'?'junction':'dir')
    await expect(installMobileFileLogger(context,root)).rejects.toThrow('mobile_log_path_invalid')
    expect(await readFile(join(outside,'sentinel'),'utf8')).toBe('unchanged')
    const second=await fixture();await mkdir(join(second.root,'logs','dsh-mobile.log'),{recursive:true})
    await expect(installMobileFileLogger(second.context,second.root)).rejects.toThrow('mobile_log_target_invalid')
  })
  it('refuses a linked leaf instead of appending to its target',async(test)=>{
    const {root,context}=await fixture();await mkdir(join(root,'logs'))
    const target=join(root,'outside.log');await writeFile(target,'unchanged')
    try {await symlink(target,join(root,'logs','dsh-mobile.log'))} catch(error) {
      if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){test.skip('Windows file symlinks require Developer Mode or elevation');return}
      throw error
    }
    await expect(installMobileFileLogger(context,root)).rejects.toThrow('mobile_log_target_invalid')
    expect(await readFile(target,'utf8')).toBe('unchanged')
  })
  it('contains a disk write error, disables only this exporter and never writes after error/disposal',async()=>{
    const {root,context}=await fixture();let acquired:WriteStream|undefined
    const observed:Message[]=[]
    context.logger.exporter({levels:{default:3},export(message){observed.push(message)}})
    await installMobileFileLogger(context,root,{createStream(handle){acquired=handle.createWriteStream({autoClose:true});return acquired}})
    if(acquired===undefined)throw new Error('stream not acquired')
    const stream=acquired;const written=vi.spyOn(stream,'write')
    const closed=new Promise<void>(resolve=>stream.once('close',resolve))
    stream.destroy(Object.assign(new Error('disk full'),{code:'ENOSPC'}));await closed
    context.logger('dsh-mobile').info('after failure')
    await context.fiber.dispose()
    context.logger('dsh-mobile').info('after dispose')
    expect(written).not.toHaveBeenCalled()
    expect(observed.filter(message=>String(message.args[0]).startsWith('file logging disabled'))).toHaveLength(1)
    expect(observed.some(message=>message.args[0]==='after failure')).toBe(true)
    expect(stream.closed).toBe(true)
  })
  it('contains formatter failures and does not recursively log through its failed file sink',async()=>{
    const {root,context}=await fixture()
    await installMobileFileLogger(context,root)
    const circular:{self?:unknown}={};circular.self=circular
    expect(()=>context.logger('dsh-mobile').info('%o',circular)).not.toThrow()
    await context.fiber.dispose()
  })
  it('contains synchronous write failures and bounds an undrained log burst',async()=>{
    const failed=await fixture();let stream:WriteStream|undefined
    await installMobileFileLogger(failed.context,failed.root,{createStream(handle){stream=handle.createWriteStream({autoClose:true});return stream}})
    if(stream===undefined)throw new Error('stream not acquired')
    const write=vi.spyOn(stream,'write').mockImplementation(()=>{throw new Error('write failed')})
    expect(()=>failed.context.logger('dsh-mobile').info('attempt')).not.toThrow()
    expect(()=>failed.context.logger('dsh-mobile').info('stopped')).not.toThrow()
    expect(write).toHaveBeenCalledTimes(1)
    await failed.context.fiber.dispose()
    const burst=await fixture();let burstStream:WriteStream|undefined
    await installMobileFileLogger(burst.context,burst.root,{createStream(handle){burstStream=handle.createWriteStream({autoClose:true});return burstStream}})
    for(let index=0;index<40;index++)burst.context.logger('dsh-mobile').info('x'.repeat(16*1024))
    expect(burstStream?.destroyed).toBe(true)
    expect(burstStream?.writableLength).toBeLessThanOrEqual(256*1024)
    await burst.context.fiber.dispose()
    expect(burstStream?.closed).toBe(true)
  })
})
