'use strict';
/**
 * web/server.js
 * Express サーバー + SSE エンドポイント
 * GET /api/research?company=会社名 → Server-Sent Events でリアルタイム配信
 */

const express  = require('express');
const path     = require('path');
const { researchCompany } = require('./lib/researcher');

const app  = express();
const PORT = process.env.PORT || 3000;

// 静的ファイル（index.html）を配信
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE エンドポイント ────────────────────────────────────────────
app.get('/api/research', async (req, res) => {
  const company = (req.query.company || '').trim();
  const url     = (req.query.url     || '').trim();

  if (!company) {
    return res.status(400).json({ error: '会社名を入力してください' });
  }

  // SSE ヘッダーを設定
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // イベントを SSE 形式で送信するヘルパー
  const send = (eventType, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await researchCompany(company, url, event => send(event.type, event));
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 担当者リサーチツール 起動中`);
  console.log(`   http://localhost:${PORT}\n`);
});
