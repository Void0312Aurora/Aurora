/** Minimal DeepSeek Harness HTTP/SSE fixture for the built-extension smoke. */

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const logPath = process.env.DSH_VSCODE_TEST_LOG
if (logPath === undefined) throw new Error('DSH_VSCODE_TEST_LOG is required')

function record(value) {
  appendFileSync(logPath, `${JSON.stringify(value)}\n`)
}

function serverRequest(rpcId, method, payload) {
  return `data: ${JSON.stringify({ type: 'server-request', rpcId, method, payload })}\n\n`
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  record({ type: 'request', method: request.method, path: url.pathname })
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ready')
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/events.host') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(serverRequest('host-session', 'events.host', {
      type: 'host/session-added',
      sessionId: 'vscode-session',
      blank: true,
      cwd: process.cwd(),
    }))
    record({ type: 'host-stream-opened' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/events.mux') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(serverRequest('approval-envelope', 'events.mux', {
      type: 'approval/requested',
      sessionId: 'vscode-session',
      approvalId: 'approval-1',
      toolName: 'bash',
      reason: 'assembled native prompt',
    }))
    record({ type: 'mux-stream-opened' })
    return
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    const body = await readJson(request)
    if (url.pathname === '/api/respond') {
      record({ type: 'approval-response', value: body.result?.value })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accepted: true }))
      return
    }
    if (url.pathname === '/api/session.injectContext') {
      record({ type: 'context-injected', payload: body.payload })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }))
      return
    }
    if (url.pathname === '/api/host.describe') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { protocolVersion: 1, version: 'test', cwd: process.cwd(), attachedSessions: 1 } },
      }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: false, error: { code: 'internal', message: 'fixture method unavailable', details: {} } },
    }))
    return
  }
  response.writeHead(404)
  response.end('not found')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
  record({ type: 'server-started', pid: process.pid })
  process.stdout.write(`dsh web: http://127.0.0.1:${String(address.port)}\n`)
})

function stop() {
  server.closeAllConnections?.()
  server.close(() => { process.exit(0) })
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
