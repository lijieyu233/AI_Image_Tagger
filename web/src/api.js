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
  photos: (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, v);
    }
    return req('GET', `/v1/photos?${q.toString()}`);
  },
  photo: (id) => req('GET', `/v1/photos/${id}`),
  setTags: (id, add, remove) => req('PUT', `/v1/photos/${id}/tags`, { add, remove }),
  reclassify: (id) => req('POST', `/v1/photos/${id}/classify`),
  deletePhoto: (id) => req('DELETE', `/v1/photos/${id}`),
  getSettings: () => req('GET', '/v1/settings'),
  saveSettings: (threshold) => req('PUT', '/v1/settings', { threshold }),
  tags: () => req('GET', '/v1/tags'),
  stats: () => req('GET', '/v1/stats'),
  tag: (limit) => req('POST', '/v1/tag', { limit }),
  export: (filters, target) => req('POST', '/v1/export', { ...filters, target }),
  thumb: (id) => `/v1/thumbs/${id}`,
  file: (id) => `/v1/files/${id}`,
};
