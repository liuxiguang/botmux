import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { resolveEntrySpawn } from '../core/self-spawn.js';
import { loadWecomConfig } from '../im/wecom/config.js';

export async function runWecomCommand(args: string[]): Promise<void> {
  if (args.length !== 3 || !['serve', 'check-config'].includes(args[0]) || args[1] !== '--config' || !args[2]) {
    console.log('用法：botmux wecom <serve|check-config> --config <配置文件>');
    process.exitCode = args.includes('--help') || args.length === 0 ? 0 : 2; return;
  }
  const configPath = resolve(args[2]);
  try {
    loadWecomConfig(configPath);
    if (args[0] === 'check-config') { console.log('企微配置完整；尚未联网验证凭证或执行 CLI。'); return; }
    const spec = resolveEntrySpawn('wecom', fileURLToPath(new URL('../', import.meta.url)));
    const child = spawn(spec.command, [...spec.args, '--config', configPath], { stdio: 'inherit', env: process.env });
    const term = () => { child.kill('SIGTERM'); }, interrupt = () => { child.kill('SIGINT'); };
    process.on('SIGTERM', term); process.on('SIGINT', interrupt);
    try {
      process.exitCode = await new Promise<number>(resolve => {
        child.once('error', () => resolve(1)); child.once('exit', (code) => resolve(code ?? 1));
      });
    } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : '企微配置或启动失败'); process.exitCode = 1;
  }
}
