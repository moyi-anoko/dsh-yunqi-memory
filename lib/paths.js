/** 数据目录解析。默认落在 $DSH_HOME/yunqi-memory，可用 config.dir 覆盖。 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function rootDir(config) {
  const custom = typeof config?.dir === 'string' ? config.dir.trim() : ''
  return custom !== '' ? custom : join(dshHome(), 'yunqi-memory')
}
