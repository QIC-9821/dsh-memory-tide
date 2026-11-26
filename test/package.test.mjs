import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function raw(path) {
  return readFileSync(`${ROOT}/${path}`)
}

test('package.json 不带 BOM 且能被 JSON.parse', () => {
  const bytes = raw('package.json')
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'package.json 不能带 UTF-8 BOM（DSH 加载器会解析失败）')
  const pkg = JSON.parse(bytes.toString('utf8'))
  assert.equal(pkg.name, 'dsh-memory-tide')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('机读配置与 locale 文件都不带 BOM', () => {
  for (const file of ['cordis.patch.yml', 'locale/zh-CN.json', 'locale/en-US.json']) {
    const bytes = raw(file)
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} 不能带 BOM`)
  }
})
