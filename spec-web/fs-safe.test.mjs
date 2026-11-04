import { describe, it, expect } from 'vitest'
import { atomicWriteFile } from './fs-safe.mjs'

const lock = (code) => Object.assign(new Error('locked'), { code })
function fakeIo(renameFails) {
  const files = new Map(), calls = { rename: 0 }
  return {
    files, calls,
    writeFileSync: (f, t) => files.set(f, Buffer.from(String(t))),
    readFileSync: (f) => files.get(f),
    rmSync: (f) => files.delete(f),
    renameSync: (a, b) => { calls.rename++; if (calls.rename <= renameFails) throw lock('EPERM'); files.set(b, files.get(a)); files.delete(a) },
  }
}

describe('atomicWriteFile', () => {
  it('retries a rename that is blocked by a lock and then succeeds', () => {
    const io = fakeIo(2)
    atomicWriteFile('x.json', '{"a":1}', io)
    expect(String(io.files.get('x.json'))).toBe('{"a":1}')
    expect(io.calls.rename).toBe(3)
    expect([...io.files.keys()]).toEqual(['x.json'])
  })
  it('falls back to overwriting in place when the lock never clears', () => {
    const io = fakeIo(99)
    atomicWriteFile('x.json', 'later', io)
    expect(String(io.files.get('x.json'))).toBe('later')
    expect([...io.files.keys()]).toEqual(['x.json'])
  })
  it('does not swallow an error that is not a lock', () => {
    const io = fakeIo(0)
    io.renameSync = () => { throw lock('ENOSPC') }
    expect(() => atomicWriteFile('x.json', 'z', io)).toThrow(/locked/)
    expect(io.files.size).toBe(0)
  })
})
