async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export const api = {
  info: () => req('GET', '/v1/info'),
  browse: () => req('POST', '/v1/browse'),
  import: (dir) => req('POST', '/v1/import', { dir }),
  importFiles: (files) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    return fetch('/v1/import-files', { method: 'POST', body: fd }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json();
    });
  },
  photos: (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, v);
    }
    return req('GET', `/v1/photos?${q.toString()}`);
  },
  photo: (id) => req('GET', `/v1/photos/${id}`),
  photoScores: (id) => req('GET', `/v1/photos/${id}/scores`),
  setTags: (id, add, remove) => req('PUT', `/v1/photos/${id}/tags`, { add, remove }),
  reclassify: (id) => req('POST', `/v1/photos/${id}/classify`),
  resetTags: (id) => req('POST', `/v1/photos/${id}/reset`),
  deletePhoto: (id) => req('DELETE', `/v1/photos/${id}`),
  getSettings: () => req('GET', '/v1/settings'),
  saveSettings: (threshold) => req('PUT', '/v1/settings', { threshold }),
  tagPreview: (threshold) => req('GET', `/v1/tag-preview?threshold=${encodeURIComponent(threshold)}`),
  tags: () => req('GET', '/v1/tags'),
  addTag: (name, group, kind) => req('POST', '/v1/tags', { name, group, kind }),
  deleteTag: (name) => req('DELETE', `/v1/tags/${encodeURIComponent(name)}`),
  stats: () => req('GET', '/v1/stats'),
  tag: (limit, scope) => req('POST', '/v1/tag', { limit, scope }),
  tagVlm: (payload) => req('POST', '/v1/tag-vlm', payload),
  reclassifyVlm: (id) => req('POST', `/v1/photos/${id}/classify-vlm`),
  confirm: (id, keep, remove) => req('POST', `/v1/photos/${id}/confirm`, { keep, remove }),
  setGroup: (name, disabled) => req('PUT', '/v1/vocab-group', { name, disabled }),
  aiSettings: () => req('GET', '/v1/ai-settings'),
  saveAiSettings: (patch) => req('PUT', '/v1/ai-settings', patch),
  aiTest: () => req('POST', '/v1/ai-test'),
  job: (id) => req('GET', `/v1/jobs/${id}`),
  export: (filters, target) => req('POST', '/v1/export', { ...filters, target }),
  thumb: (id) => `/v1/thumbs/${id}`,
  file: (id) => `/v1/files/${id}`,
};
