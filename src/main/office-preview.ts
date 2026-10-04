/**
 * Office → PDF 转换（2026-10-04）
 *
 * 供「本机内文件」面板内预览 docx/xlsx/pptx 使用：复用 office-runtime 物化出来的
 * 转换栈（真实目录，带执行位的引擎），把文档转成 PDF 放进临时目录，再把 PDF 交给面板。
 *
 * 为什么不直接嵌 Office 引擎：面板在 http://127.0.0.1 的页面里，读不了 file://，
 * 所以主进程转、主进程读，最终以 data URI 交给渲染层。
 */
import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export async function convertOfficeToPdf(inputPath: string): Promise<{ ok: boolean; pdfPath?: string; error?: string }> {
  const home = path.join(app.getPath('userData'), 'dsh-home');
  const nodeBin = path.join(home, 'office-runtime', 'bin', 'node');
  const cli = path.join(
    home,
    'office-runtime',
    'kit',
    'node_modules',
    '@deepseek-ai',
    'libreoffice-kit',
    'lib',
    'cli.js',
  );
  if (!fs.existsSync(nodeBin) || !fs.existsSync(cli)) {
    return { ok: false, error: 'Office 预览组件尚未就绪，请重启一次应用后再试' };
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-office-preview-'));
  const outPdf = path.join(outDir, 'out.pdf');
  return await new Promise((resolve) => {
    const child = spawn(nodeBin, [cli, 'convert', '--input', inputPath, '--output', outPdf], {
      timeout: 120000,
    });
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('error', (e) => resolve({ ok: false, error: '启动转换进程失败：' + e.message }));
    child.on('close', () => {
      if (fs.existsSync(outPdf)) resolve({ ok: true, pdfPath: outPdf });
      else resolve({ ok: false, error: '转换失败：' + out.slice(0, 200) });
    });
  });
}
