#!/usr/bin/env node
import { runWecom } from './im/wecom/runtime.js';
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
installStdioEpipeGuard();

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) {
  console.error('企微服务需要 --config <配置文件>'); process.exit(2);
} else {
  runWecom(process.argv[index + 1]).then(() => process.exit(0)).catch(error => {
    console.error(`[wecom] ${error instanceof Error ? error.message : '启动失败'}`);
    process.exit(1);
  });
}
