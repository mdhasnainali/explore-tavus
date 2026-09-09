// Minimal Tavus API client. No dependencies -- uses native fetch.
//
// Naming note: Tavus renamed "persona" to PAL and "replica" to Face.
// The legacy /v2/personas and /v2/replicas paths still work as aliases,
// but this client uses the current names.

const BASE = 'https://tavusapi.com';

export class TavusError extends Error {
  constructor(status, body, method, path) {
    const detail =
      typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    super(`${method} ${path} -> ${status}\n${detail}`);
    this.name = 'TavusError';
    this.status = status;
    this.body = body;
  }
}

export class Tavus {
  constructor(apiKey) {
    if (!apiKey) throw new Error('Missing Tavus API key.');
    this.apiKey = apiKey;
  }

  async request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let parsed = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as raw text
      }
    }

    if (!res.ok) throw new TavusError(res.status, parsed, method, path);
    return parsed;
  }

  // --- Faces (formerly replicas) ---

  listFaces() {
    return this.request('GET', '/v2/faces');
  }

  // --- Documents (knowledge base) ---

  // document_url must be publicly reachable. Tavus fetches it server-side;
  // there is no multipart upload endpoint.
  createDocument({ documentUrl, documentName, tags }) {
    return this.request('POST', '/v2/documents', {
      document_url: documentUrl,
      ...(documentName ? { document_name: documentName } : {}),
      ...(tags?.length ? { tags } : {}),
    });
  }

  getDocument(documentId) {
    return this.request('GET', `/v2/documents/${documentId}`);
  }

  listDocuments() {
    return this.request('GET', '/v2/documents');
  }

  // Poll until the document leaves the processing states. Tavus docs say
  // this normally takes 5-10 minutes depending on file size.
  async waitForDocument(documentId, { timeoutMs = 15 * 60_000, intervalMs = 10_000, onTick } = {}) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const doc = await this.getDocument(documentId);
      onTick?.(doc);

      if (doc.status === 'ready') return doc;
      if (doc.status === 'error') {
        throw new Error(
          `Document processing failed: ${doc.error_message ?? 'unknown error'}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Document ${documentId} still "${doc.status}" after ${Math.round(timeoutMs / 60_000)} min.`,
        );
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // --- PALs (formerly personas) ---

  createPal(payload) {
    return this.request('POST', '/v2/pals', payload);
  }

  getPal(palId) {
    return this.request('GET', `/v2/pals/${palId}`);
  }

  // `pal_type=user` excludes the stock PALs Tavus ships on every account.
  listPals({ palType = 'user', limit = 100, page = 1 } = {}) {
    const qs = new URLSearchParams({
      pal_type: palType,
      limit: String(limit),
      page: String(page),
    });
    return this.request('GET', `/v2/pals?${qs}`);
  }

  // The endpoint pages at 10 by default and reports total_count, so walk it
  // until every PAL is collected.
  async listAllPals({ palType = 'user', pageSize = 100, maxPages = 50 } = {}) {
    const all = [];

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.listPals({ palType, limit: pageSize, page });
      const batch = Array.isArray(res) ? res : (res.data ?? []);
      all.push(...batch);

      const total = res?.total_count;
      if (batch.length < pageSize) break;
      if (typeof total === 'number' && all.length >= total) break;
    }

    return all;
  }

  deletePal(palId) {
    return this.request('DELETE', `/v2/pals/${palId}`);
  }

  // --- Conversations ---

  createConversation(payload) {
    return this.request('POST', '/v2/conversations', payload);
  }

  listConversations(status) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request('GET', `/v2/conversations${qs}`);
  }

  // Routine cleanup. Frees the room and stops billing for the call.
  endConversation(conversationId) {
    return this.request('POST', `/v2/conversations/${conversationId}/end`);
  }
}
