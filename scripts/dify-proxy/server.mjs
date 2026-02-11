#!/usr/bin/env node
import { createServer } from "node:http"
import { URL } from "node:url"

const PORT = Number(process.env.PORT || 4000)
const HOST = process.env.HOST || "0.0.0.0"
const DIFY_UPSTREAM_BASE_URL = process.env.DIFY_UPSTREAM_BASE_URL || ""
const PROXY_LOG = process.env.PROXY_LOG === "1"
const AUTO_CANCEL_PREVIOUS = process.env.AUTO_CANCEL_PREVIOUS !== "0"

if (!DIFY_UPSTREAM_BASE_URL) {
	console.error("[dify-proxy] Missing DIFY_UPSTREAM_BASE_URL")
	process.exit(1)
}

/**
 * key: `${user}::${conversationId}`
 * value: upstream task_id
 */
const conversationTaskMap = new Map()

function log(...args) {
	if (PROXY_LOG) {
		console.log("[dify-proxy]", ...args)
	}
}

function buildUpstreamUrl(reqUrl) {
	const base = DIFY_UPSTREAM_BASE_URL.replace(/\/$/, "")
	const path = reqUrl.startsWith("/") ? reqUrl : `/${reqUrl}`
	return `${base}${path}`
}

function parseJsonSafe(input) {
	try {
		return JSON.parse(input)
	} catch {
		return null
	}
}

function parseTaskKey(body, fallbackConversationId = "") {
	const user = typeof body?.user === "string" && body.user ? body.user : "cline-user"
	const conversationId =
		typeof body?.conversation_id === "string" && body.conversation_id ? body.conversation_id : fallbackConversationId
	if (!conversationId) {
		return null
	}
	return `${user}::${conversationId}`
}

async function readBody(req) {
	const chunks = []
	for await (const chunk of req) {
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

async function tryStopPreviousTask(body) {
	if (!AUTO_CANCEL_PREVIOUS) {
		return
	}
	const key = parseTaskKey(body)
	if (!key) {
		return
	}
	const oldTaskId = conversationTaskMap.get(key)
	if (!oldTaskId) {
		return
	}
	const stopUrl = `${DIFY_UPSTREAM_BASE_URL.replace(/\/$/, "")}/chat-messages/${oldTaskId}/stop`
	try {
		log("stopping previous task", { key, oldTaskId })
		await fetch(stopUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ user: body?.user || "cline-user" }),
		})
	} catch (error) {
		log("failed to stop previous task", error)
	}
}

function writeHeadersFromUpstream(res, upstreamRes, override = {}) {
	res.statusCode = upstreamRes.status
	for (const [name, value] of upstreamRes.headers.entries()) {
		if (name.toLowerCase() === "content-length") {
			continue
		}
		res.setHeader(name, value)
	}
	for (const [name, value] of Object.entries(override)) {
		res.setHeader(name, value)
	}
}

function mergeAnswerChunk(currentText, lastAnswer, incomingText) {
	if (!incomingText) {
		return { mergedText: currentText, nextLastAnswer: lastAnswer }
	}
	if (lastAnswer && incomingText.startsWith(lastAnswer)) {
		return { mergedText: incomingText, nextLastAnswer: incomingText }
	}
	if (!lastAnswer) {
		return { mergedText: incomingText, nextLastAnswer: incomingText }
	}
	const merged = `${currentText}${incomingText}`
	return { mergedText: merged, nextLastAnswer: merged }
}

async function proxyChatMessages(req, res, reqBodyBuffer) {
	const reqText = reqBodyBuffer.toString("utf8")
	const bodyJson = parseJsonSafe(reqText) || {}
	await tryStopPreviousTask(bodyJson)

	const upstream = await fetch(buildUpstreamUrl(req.url), {
		method: "POST",
		headers: req.headers,
		body: reqBodyBuffer,
	})

	if (!upstream.body) {
		writeHeadersFromUpstream(res, upstream)
		const text = await upstream.text()
		res.end(text)
		return
	}

	writeHeadersFromUpstream(res, upstream, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	})

	let buffer = ""
	let fullText = ""
	let lastAnswer = ""
	let currentConversationId = bodyJson?.conversation_id || ""
	let currentUser = bodyJson?.user || "cline-user"

	const reader = upstream.body.getReader()
	const decoder = new TextDecoder()

	const emitLine = (line) => {
		res.write(line)
		if (!line.endsWith("\n")) {
			res.write("\n")
		}
	}

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}

			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split("\n")
			buffer = lines.pop() || ""

			for (const rawLine of lines) {
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
				if (!line.startsWith("data: ")) {
					emitLine(`${line}\n`)
					continue
				}

				const data = line.slice(6).trim()
				if (!data || data === "[DONE]") {
					emitLine(`data: ${data}\n\n`)
					continue
				}

				const parsed = parseJsonSafe(data)
				if (!parsed) {
					emitLine(`data: ${data}\n\n`)
					continue
				}

				if (typeof parsed.user === "string" && parsed.user) {
					currentUser = parsed.user
				}
				if (typeof parsed.conversation_id === "string" && parsed.conversation_id) {
					currentConversationId = parsed.conversation_id
				}
				if (typeof parsed.task_id === "string" && parsed.task_id && currentConversationId) {
					conversationTaskMap.set(`${currentUser}::${currentConversationId}`, parsed.task_id)
				}

				if (typeof parsed.answer === "string") {
					const merged = mergeAnswerChunk(fullText, lastAnswer, parsed.answer)
					fullText = merged.mergedText
					lastAnswer = merged.nextLastAnswer
					parsed.answer = fullText
				}

				emitLine(`data: ${JSON.stringify(parsed)}\n\n`)
			}
		}

		if (buffer.trim()) {
			emitLine(`${buffer}\n`)
		}
	} finally {
		reader.releaseLock()
	}

	res.end()
}

async function proxyPassthrough(req, res, reqBodyBuffer) {
	const upstream = await fetch(buildUpstreamUrl(req.url), {
		method: req.method,
		headers: req.headers,
		body: reqBodyBuffer.length > 0 ? reqBodyBuffer : undefined,
	})

	writeHeadersFromUpstream(res, upstream)

	if (!upstream.body) {
		res.end(await upstream.text())
		return
	}

	const arrayBuffer = await upstream.arrayBuffer()
	res.end(Buffer.from(arrayBuffer))
}

const server = createServer(async (req, res) => {
	try {
		if (!req.url || !req.method) {
			res.statusCode = 400
			res.end("Invalid request")
			return
		}

		if (req.url === "/healthz") {
			res.statusCode = 200
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify({ ok: true }))
			return
		}

		const reqBodyBuffer = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req)
		const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname

		if (req.method === "POST" && pathname === "/chat-messages") {
			await proxyChatMessages(req, res, reqBodyBuffer)
			return
		}

		await proxyPassthrough(req, res, reqBodyBuffer)
	} catch (error) {
		res.statusCode = 500
		res.setHeader("content-type", "application/json")
		res.end(
			JSON.stringify({
				error: "dify_proxy_error",
				message: error instanceof Error ? error.message : String(error),
			}),
		)
	}
})

server.listen(PORT, HOST, () => {
	console.log(
		`[dify-proxy] listening on http://${HOST}:${PORT}, upstream=${DIFY_UPSTREAM_BASE_URL}, autoCancel=${AUTO_CANCEL_PREVIOUS}`,
	)
})
