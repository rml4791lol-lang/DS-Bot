// A long-lived ego-browser process per Bot: it owns one task space, streams JPEG
// frames of its page to the host over a loopback TCP socket, and takes mouse and
// keyboard commands back on the same socket. ego-browser buffers console output
// until the script exits, so the socket is the only live channel.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

export const FRAME_INTERVAL_MS = 400
export const FRAME_QUALITY = 45
export const FRAME_SCALE = 0.6

/**
 * @param {{ space: string, profileName?: string, intervalMs?: number, port: number, token: string }} input
 */
export function buildDriver({ space, profileName, intervalMs = FRAME_INTERVAL_MS, port, token }) {
  return `(async () => {
  const net = require('node:net');
  const socket = net.createConnection({ host: '127.0.0.1', port: ${Number(port)} });
  socket.setNoDelay(true);
  const send = obj => { if (!socket.destroyed) socket.write(JSON.stringify({ ...obj, token: ${JSON.stringify(token)} }) + '\\n'); };
  const spaceName = ${JSON.stringify(space)};
  const profileName = ${JSON.stringify(profileName ?? '')};
  let profile;
  if (profileName) {
    const list = await profiles();
    profile = list.find(item => item.name === profileName);
  }
  const task = await taskSpace(spaceName, profile ? { profileId: profile.id } : undefined);
  const pages = await task.pages();
  const page = pages[0] ?? await task.newPage();
  send({ type: 'ready', spaceId: task.spaceId, profileId: profile ? profile.id : null, profileName: profile ? profile.name : null });
  const metrics = async () => {
    const m = await page.cdp('Page.getLayoutMetrics');
    return m.cssLayoutViewport;
  };
  let seq = 0;
  let busy = false;
  const emit = async () => {
    if (busy || socket.destroyed || !socket.writable) return;
    busy = true;
    try {
      const viewport = await metrics();
      const shot = await page.cdp('Page.captureScreenshot', {
        format: 'jpeg',
        quality: ${FRAME_QUALITY},
        clip: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale: ${FRAME_SCALE} },
        captureBeyondViewport: false,
      });
      seq += 1;
      send({
        type: 'frame',
        seq,
        mime: 'image/jpeg',
        data: shot.data,
        width: Math.round(viewport.clientWidth * ${FRAME_SCALE}),
        height: Math.round(viewport.clientHeight * ${FRAME_SCALE}),
        url: await page.url(),
        title: await page.title(),
        time: Date.now(),
      });
    } catch (error) {
      send({ type: 'frame-error', message: String(error && error.message || error) });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(emit, ${intervalMs});
  emit();
  let buffer = '';
  socket.on('data', async chunk => {
    buffer += chunk;
    const lines = buffer.split('\\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let command;
      try { command = JSON.parse(line); } catch { continue; }
      try {
        if (command.type === 'click') {
          const viewport = await metrics();
          const x = Math.max(0, Math.min(1, Number(command.x ?? 0.5))) * viewport.clientWidth;
          const y = Math.max(0, Math.min(1, Number(command.y ?? 0.5))) * viewport.clientHeight;
          await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } else if (command.type === 'wheel') {
          const viewport = await metrics();
          await page.cdp('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Number(command.x ?? 0.5) * viewport.clientWidth,
            y: Number(command.y ?? 0.5) * viewport.clientHeight,
            deltaX: Number(command.deltaX ?? 0),
            deltaY: Number(command.deltaY ?? 0),
          });
        } else if (command.type === 'insert') {
          await page.cdp('Input.insertText', { text: String(command.text ?? '') });
        } else if (command.type === 'key') {
          const key = String(command.key ?? '');
          const named = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
          const code = named[key];
          if (code === undefined) continue;
          await page.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, windowsVirtualKeyCode: code });
          await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code });
        } else if (command.type === 'navigate') {
          await page.goto(String(command.url), { waitUntil: 'domcontentloaded' }).catch(() => {});
        } else if (command.type === 'stop') {
          clearInterval(timer);
          socket.end();
          process.exit(0);
        }
      } catch (error) {
        send({ type: 'input-error', message: String(error && error.message || error) });
      }
    }
  });
  socket.on('close', () => { clearInterval(timer); process.exit(0); });
  socket.on('error', () => { clearInterval(timer); process.exit(0); });
})().catch(error => {
  const net = require('node:net');
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: ${Number(port)} });
    socket.on('connect', () => { socket.write(JSON.stringify({ type: 'fatal', token: ${JSON.stringify(token)}, message: String(error && error.message || error) }) + '\\n'); socket.end(); });
  } catch {}
  process.exitCode = 1;
});
`
}

/**
 * One ego page streamed to the host.
 */
export class EgoBridge {
  constructor({ cli, space, profileName, spawnImpl = spawn, frameIntervalMs = FRAME_INTERVAL_MS } = {}) {
    this.cli = cli
    this.space = space
    this.profileName = profileName
    this.spawnImpl = spawnImpl
    this.intervalMs = frameIntervalMs
    this.token = randomUUID()
    this.child = null
    this.socket = null
    this.server = null
    this.frame = null
    this.error = null
    this.profile = null
    this.closed = false
    this.ready = null
    this.waiters = new Set()
  }

  start() {
    if (this.server || this.closed) return this
    this.ready = new Promise(resolve => { this._resolveReady = resolve })
    this.server = createServer(socket => {
      socket.setNoDelay(true)
      if (this.socket) { socket.destroy(); return }
      this.socket = socket
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) this._onLine(line)
      })
      socket.on('close', () => { if (this.socket === socket) this.socket = null })
      socket.on('error', () => {})
    })
    this.server.on('error', error => { this.error = `bridge server: ${error?.message ?? error}`; this._resolveReady?.(null) })
    this.server.listen(0, '127.0.0.1', () => {
      const port = this.server.address().port
      const script = buildDriver({ space: this.space, profileName: this.profileName, intervalMs: this.intervalMs, port, token: this.token })
      this.child = this.spawnImpl(this.cli, ['nodejs', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.child.stderr?.on('data', chunk => {
        const text = String(chunk).trim()
        if (text && this.error === null) this.error = text.slice(0, 400)
      })
      this.child.on?.('exit', () => { this.child = null })
    })
    return this
  }

  _onLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.token !== this.token) return
    if (message.type === 'frame') {
      this.frame = {
        mime: message.mime ?? 'image/jpeg',
        data: message.data,
        width: message.width,
        height: message.height,
        url: message.url ?? '',
        title: message.title ?? '',
        seq: message.seq,
        time: message.time,
      }
      for (const waiter of this.waiters) waiter(this.frame)
      this.waiters.clear()
    } else if (message.type === 'ready') {
      this.profile = { id: message.profileId ?? null, name: message.profileName ?? null }
      this._resolveReady?.(this.profile)
    } else if (message.type === 'fatal') {
      this.error = message.message ?? 'ego driver stopped'
      this._resolveReady?.(null)
    }
  }

  latest() {
    return this.frame ?? undefined
  }

  waitForFrame(since, timeoutMs = 800) {
    if (this.frame && (since === undefined || this.frame.seq > since)) return Promise.resolve(this.frame)
    return new Promise(resolve => {
      const done = frame => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve(frame)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(done)
        resolve(this.frame ?? undefined)
      }, timeoutMs)
      this.waiters.add(done)
    })
  }

  input(command) {
    if (!this.socket?.writable) return false
    this.socket.write(`${JSON.stringify({ ...command, token: this.token })}\n`)
    return true
  }

  stop() {
    this.closed = true
    try { this.input({ type: 'stop' }) } catch { /* already gone */ }
    try { this.socket?.end() } catch { /* ignore */ }
    this.socket = null
    const child = this.child
    this.child = null
    setTimeout(() => { try { child?.kill?.() } catch { /* ignore */ } }, 500).unref?.()
    this.server?.close()
    this.server = null
    this._resolveReady?.(null)
  }
}
