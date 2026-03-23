'use strict';
/**
 * web/lib/researcher.js
 * 会社名から担当者を複数ソースで収集するコアモジュール
 * ソース: PR TIMES / 会社HP / Wantedly / LinkedIn
 *
 * 検索エンジン: Yahoo Japan（サーバーサイドレンダリング、ボットブロック少）
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
};
const YAHOO_HEADERS = { ...HEADERS, 'Referer': 'https://search.yahoo.co.jp/' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

const DOMAIN_BLACKLIST = [
  'prtimes.jp', 'prtimes.co.jp',
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'line.me', 'google.com', 'amazon.co.jp', 'rakuten.co.jp',
  'tayori.com', 'jooto.com', 'apple.com', 'linkedin.com', 'wantedly.com',
  'yahoo.co.jp', 'bing.com', 'wikipedia.org',
];

// ─── Yahoo Japan 検索ヘルパー ─────────────────────────────────────────
async function yahooSearch(query) {
  const url = `https://search.yahoo.co.jp/search?p=${encodeURIComponent(query)}&ei=UTF-8`;
  const res = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 15000 });

  const $ = cheerio.load(res.data);
  const results = [];

  $('div.sw-CardBase').each((_, el) => {
    const href    = $(el).find('a.sw-Card__titleInner').attr('href') || '';
    const title   = $(el).find('.sw-Card__titleMain--clamp').first().text().trim();
    const snippet = $(el).find('.sw-Card__summary').text().trim().replace(/\s+/g, ' ');

    // Yahoo内部URLや画像検索は除外
    if (!href || href.includes('search.yahoo.co.jp') || href.includes('/image/')) return;

    results.push({ title, url: href, snippet });
  });

  return results;
}

// ─── PR TIMES: リリース本文から担当者テキスト・外部リンクを抽出 ────────
async function extractFromRelease(releaseUrl) {
  const res = await axios.get(releaseUrl, { headers: HEADERS, timeout: 15000 });
  const $   = cheerio.load(res.data);

  const contactText = [];
  $('p, div, td, section').each((_, el) => {
    const text = $(el).text().trim();
    if ((text.includes('お問い合わせ') || text.includes('担当') ||
         text.includes('広報') || text.includes('PR')) && text.length < 500) {
      contactText.push(text);
    }
  });

  const externalLinks = [];
  $('a[href^="http"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const host = new URL(href).hostname;
      if (!DOMAIN_BLACKLIST.some(b => host.includes(b)) && host.includes('.')) {
        externalLinks.push(host);
      }
    } catch {}
  });

  return {
    contactTexts:  contactText.slice(0, 5),
    externalHosts: [...new Set(externalLinks)].slice(0, 5),
  };
}

// ─── テキストから人名・役職を抽出 ────────────────────────────────────
function extractPersonsFromText(texts) {
  const persons   = [];
  const skipWords = ['株式会社', '合同会社', '有限会社', '事務局', '委員会'];

  // 役職キーワード（代表・取締役・広報など明確な役職のみ。ブランド・PRなど曖昧な語は除外）
  const ROLES = '代表取締役社長|代表取締役|取締役|執行役員|社長|会長|副社長|専務|常務'
              + '|部長|課長|マネージャー|ディレクター|広報|担当';

  // 役職を含む行だけに絞る（マーケ文章などのノイズを除去）
  const roleRegex = new RegExp(ROLES);
  const filtered = texts
    .filter(Boolean)
    .join('\n')
    .split(/\n/)
    .filter(line => line.length < 120 && roleRegex.test(line))
    .join('\n');

  if (!filtered) return persons;

  // 名前パターン: 漢字{1-4} + スペース任意 + 漢字orかなカナ{1-5}
  const NAME = '[一-龯]{1,4}[\\s　]?[一-龯ぁ-んァ-ン]{1,5}';

  const extractors = [
    // 「代表取締役 田中 太郎」「広報担当：山田花子」— 役職 → 名前（セパレータ必須）
    {
      re:      new RegExp(`(?:${ROLES})[社員部室長]?[：:\\s　]{1,5}(${NAME})`, 'g'),
      getRole: m => m[0].replace(m[1], '').replace(/[：:\s　]/g, '').trim(),
    },
    // 「田中 太郎 代表取締役」「田中太郎（マーケ部長）」— 名前 → 役職
    {
      re:      new RegExp(`(${NAME})[\\s　：:（(]{1,3}(?:${ROLES})`, 'g'),
      getRole: m => m[0].replace(m[1], '').replace(/[\s　：:（(）)]/g, '').trim(),
    },
    // 単独行の人名（スペース必須: 姓 名）
    {
      re:      /^([一-龯]{1,4}[\s　][一-龯ぁ-んァ-ン]{1,5})$/mg,
      getRole: () => '',
    },
  ];

  // 役職のみの文字列を名前として誤抽出しないためのフィルター
  const ROLE_ONLY = /^(代表取締役社長|代表取締役|取締役社長|取締役|執行役員|専務取締役|常務取締役|社長|会長|副社長|専務|常務|部長|課長|担当者?|広報|PR|マーケティング|宣伝|ブランド|マネージャー|ディレクター)$/;

  for (const { re, getRole } of extractors) {
    let m;
    while ((m = re.exec(filtered)) !== null) {
      const name = m[1].trim().replace(/[\s　]+/g, ' ');
      if (name.length < 2 || name.length > 12) continue;
      const nameKey = name.replace(/[\s　]/g, '');
      if (persons.find(p => p.name.replace(/[\s　]/g, '') === nameKey)) continue;
      if (skipWords.some(w => name.includes(w))) continue;
      if (ROLE_ONLY.test(nameKey)) continue;
      // 部署名（〜部, 〜課, 〜局）を名前として除外
      if (/[部課局]$/.test(nameKey)) continue;
      const role     = getRole(m);
      const isTarget = /マーケ|広報|PR|ブランド|宣伝|代表|社長|取締役/.test(role);
      persons.push({ name, role, confidence: isTarget ? '◎' : '○' });
    }
  }

  return persons.slice(0, 5);
}

// ─── ドメイン: PR TIMESお問い合わせ欄のURL記載から抽出 ───────────────
function extractCompanyUrl(bodyText) {
  const m = bodyText.match(/URL[：:\s]*(https?:\/\/[^\s\u3000-\u9fff]+)/i);
  if (m) {
    try { return new URL(m[1]).hostname.replace(/^www\./, ''); } catch {}
  }
  return null;
}

// ─── ドメイン: Yahoo検索結果（PR TIMES検索と兼用）から抽出 ─────────
// 追加のYahoo検索を避けるため、PR TIMES検索結果のPR TIMES以外URLを使用
function extractDomainFromSearchResults(items) {
  for (const { url, title } of items) {
    if (!url) continue;
    if (/prtimes\.jp/.test(url)) continue;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (DOMAIN_BLACKLIST.some(b => host.includes(b))) continue;
      // 「公式」タイトルを優先
      if (/公式|Official/i.test(title || '')) return host;
    } catch {}
  }
  // 公式なしなら最初の非ブラックリストURLを使用
  for (const { url } of items) {
    if (!url || /prtimes\.jp/.test(url)) continue;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (!DOMAIN_BLACKLIST.some(b => host.includes(b))) return host;
    } catch {}
  }
  return null;
}

// ─── 会社HP: コンタクト・aboutページから担当者を抽出 ─────────────────
async function extractFromCompanyHP(domain) {
  const persons = [];
  if (!domain) return persons;

  const baseUrl = `https://${domain}`;
  const candidatePaths = new Set([
    '/contact', '/about', '/company', '/team', '/staff',
    '/about-us', '/aboutus', '/corporate',
    '/ja/contact', '/ja/about', '/ja/company',
    '/contact/', '/about/', '/company/',
    '/contact.html', '/about.html',
  ]);

  // www. なしで失敗した場合は www. 付きも試す
  let homeHtml = null;
  for (const tryUrl of [baseUrl, `https://www.${domain}`]) {
    try {
      const homeRes = await axios.get(tryUrl, { headers: HEADERS, timeout: 10000 });
      homeHtml = homeRes.data;
      break;
    } catch {}
  }

  if (homeHtml) {
    const $h = cheerio.load(homeHtml);

    // ホームページのテキスト自体も解析
    const homePersons = extractPersonsFromText([$h.text()]);
    if (homePersons.length > 0) {
      persons.push(...homePersons.map(p => ({ ...p, source: '会社HP', sourceUrl: baseUrl })));
    }

    // コンタクト系リンクを追加発見
    $h('a[href]').each((_, el) => {
      const href = $h(el).attr('href') || '';
      const text = $h(el).text().trim().toLowerCase();
      const isRelevant =
        text.includes('会社概要') || text.includes('企業情報') || text.includes('お問い合わせ') ||
        text.includes('チーム') || text.includes('スタッフ') ||
        text.includes('about') || text.includes('contact') ||
        text.includes('team') || text.includes('corporate');
      if (isRelevant) {
        try {
          const u = new URL(href, baseUrl);
          if (u.hostname.replace(/^www\./, '') === domain) candidatePaths.add(u.pathname);
        } catch {}
      }
    });
  }

  // 各候補ページをスクレイピング（ホームページで見つかった場合はスキップ）
  if (persons.length === 0) {
    for (const p of [...candidatePaths].slice(0, 12)) {
      const pageUrl = `${baseUrl}${p}`;
      try {
        await sleep(400);
        const res = await axios.get(pageUrl, { headers: HEADERS, timeout: 8000 });
        const $   = cheerio.load(res.data);
        const found = extractPersonsFromText([$.text()]);
        if (found.length > 0) {
          persons.push(...found.map(fp => ({ ...fp, source: '会社HP', sourceUrl: pageUrl })));
          break;
        }
      } catch {}
    }
  }

  return persons;
}

// ─── LinkedIn / Wantedly 結果から担当者を解析 ────────────────────────
function parseLinkedInTitle(title, snippet) {
  // フォーマット例:
  //   "Akihiko Fujita - Lush Japan Head of People - LinkedIn"
  //   "加藤 快 - 店舗開発、商品開発、広報をマネジメントします"
  //   "Chika Maruta - ラッシュジャパン合同会社 (LUSH JAPAN G.K.)"

  // LinkedIn サイト名を除去
  const cleaned = title.replace(/\s*[-–|｜]\s*LinkedIn\s*$/i, '').trim();

  const parts = cleaned.split(/\s*[-–]\s*/);
  if (parts.length < 2) return null;

  const name = parts[0].trim();
  const rest = parts.slice(1).join(' - ').trim();

  // 名前バリデーション: 日本語か英語か
  const isJaName = /[一-龯ぁ-んァ-ン]/.test(name) && name.length <= 12;
  const isEnName = /^[A-Z][a-z]/.test(name) && name.split(/\s+/).length >= 2 && name.length <= 30;
  if (!isJaName && !isEnName) return null;

  // 役職判定（会社名は除外）
  const isCompanyName = /合同会社|株式会社|有限会社|G\.K\.|inc|corp|ltd/i.test(rest);
  // ダッシュのみや空の役職は除外
  const cleanRest = rest.replace(/^[-–—\s]+$/, '').trim();
  const role = (isCompanyName || !cleanRest) ? '' : cleanRest;

  // スニペットから役職を補完
  const roleFromSnippet = snippet.match(/(?:マーケティング|広報|PR|ブランド|宣伝|代表取締役|取締役|社長|Head|Manager|Director)[^\s。、\n]{0,20}/)?.[0] || '';
  const finalRole = role || roleFromSnippet;
  const isTarget  = /マーケ|広報|PR|ブランド|宣伝/i.test(finalRole);

  return { name, role: finalRole, confidence: isTarget ? '◎' : '○', source: 'LinkedIn' };
}

function parseWantedlyTitle(title, snippet, url) {
  // プロフィールURL: wantedly.com/id/xxx
  const isProfile = /wantedly\.com\/(id\/|profiles\/)/.test(url);
  if (!isProfile) return null;

  // "名前のプロフィール - Wantedly" や "名前 | Wantedly"
  const cleaned = title
    .replace(/のプロフィール.*$/,'')
    .replace(/\s*[|｜-]\s*Wantedly.*$/i, '')
    .trim();

  // 日本語名チェック
  const isJa = /^[一-龯ぁ-んァ-ン\s　]{2,12}$/.test(cleaned);
  if (!isJa && !/^[A-Z]/.test(cleaned)) return null;
  if (cleaned.length > 20) return null;

  const role = snippet.match(/(?:マーケティング|広報|PR|ブランド|宣伝|代表取締役|取締役|社長|Manager|Director)[^\s。、\n]{0,20}/)?.[0] || '';
  const isTarget = /マーケ|広報|PR|ブランド|宣伝/.test(role);

  return { name: cleaned, role, confidence: isTarget ? '◎' : '○', source: 'Wantedly' };
}

// ─── 担当者統合検索（Wantedly + LinkedIn + 一般）─ Yahoo 1回でカバー ──
async function searchPersonsCombined(companyName) {
  const result = { wantedly: [], linkedin: [], general: [] };

  try {
    const query = `"${companyName}" wantedly OR linkedin 代表取締役 OR 広報 OR マーケティング`;
    const items = await yahooSearch(query);

    for (const { title, url, snippet } of items) {
      if (url.includes('linkedin.com')) {
        const person = parseLinkedInTitle(title, snippet);
        if (person) result.linkedin.push(person);

      } else if (url.includes('wantedly.com')) {
        const person = parseWantedlyTitle(title, snippet, url);
        if (person) result.wantedly.push(person);

      } else {
        // 一般ページ（スニペット・タイトルから抽出）
        const found = extractPersonsFromText([title, snippet]);
        result.general.push(...found.map(p => ({ ...p, source: '会社HP' })));
      }
    }

    const total = result.wantedly.length + result.linkedin.length + result.general.length;
    if (total > 0) {
      const names = [
        ...result.wantedly.map(p => `${p.name}(W)`),
        ...result.linkedin.map(p => `${p.name}(LI)`),
        ...result.general.map(p => `${p.name}(HP)`),
      ];
      console.log(`    🔍 統合検索: ${names.join(', ')}`);
    } else {
      console.log('    🔍 統合検索: 該当なし');
    }
  } catch (e) {
    console.log(`    ⚠️ 統合検索エラー: ${e.message}`);
  }

  return result;
}

// ─── 複数ソースの担当者をマージ・重複排除 ───────────────────────────
function mergePersons(arrays) {
  const map = new Map();

  for (const persons of arrays) {
    for (const p of persons) {
      const key = p.name.replace(/[\s　]/g, '');
      if (map.has(key)) {
        const existing = map.get(key);
        if (!existing.sources.includes(p.source)) existing.sources.push(p.source);
        if (p.role && !existing.role) existing.role = p.role;
        if (existing.sources.length >= 2) existing.confidence = '◎';
      } else {
        map.set(key, {
          name:       p.name,
          role:       p.role || '',
          confidence: p.confidence,
          sources:    [p.source],
        });
      }
    }
  }

  const CONF_ORDER = { '◎': 0, '○': 1, '△': 2 };
  return [...map.values()]
    .map(p => ({ ...p, source: p.sources.join(' / ') }))
    .sort((a, b) => (CONF_ORDER[a.confidence] ?? 3) - (CONF_ORDER[b.confidence] ?? 3));
}

// ─── メイン: 会社名から担当者を一括リサーチ ─────────────────────────
async function researchCompany(companyName, emit) {
  let domain = null;
  const collected = {
    prtimes:  [],
    hp:       [],
    wantedly: [],
    linkedin: [],
    general:  [],
  };

  // ① PR TIMES（Yahoo検索 → リリースURL取得 → 本文スクレイピング）
  emit({ type: 'status', source: 'prtimes', message: '検索中...' });
  try {
    const items = await yahooSearch(`"${companyName}" prtimes.jp プレスリリース`);

    // Yahoo結果からprtimesリリースURLを直接収集
    const releaseUrls = items
      .map(i => i.url)
      .filter(u => /prtimes\.jp\/main\/html\/rd\//.test(u))
      .slice(0, 3);

    console.log(`  PR TIMES: ${releaseUrls.length}件のリリースURL取得`);

    const allContactTexts  = [];
    const allExternalHosts = [];

    for (const url of releaseUrls) {
      try {
        const info = await extractFromRelease(url);
        if (info) {
          allContactTexts.push(...info.contactTexts);
          allExternalHosts.push(...info.externalHosts);
        }
        await sleep(1000);
      } catch {}
    }

    const bodyText = allContactTexts.join(' ');
    // PR TIMESのURL記載 → なければ同じYahoo検索結果からドメインを取得
    domain = extractCompanyUrl(bodyText) || extractDomainFromSearchResults(items);
    if (domain) emit({ type: 'domain', domain });

    collected.prtimes = extractPersonsFromText(allContactTexts)
      .map(p => ({ ...p, source: 'PR TIMES' }));
    emit({ type: 'source_result', source: 'PR TIMES', persons: collected.prtimes });
  } catch (e) {
    console.log(`  ⚠️ PR TIMES検索エラー: ${e.message}`);
    emit({ type: 'source_result', source: 'PR TIMES', persons: [] });
  }

  // ② 会社HP（直接スクレイピング）
  emit({ type: 'status', source: 'hp', message: '確認中...' });
  try {
    collected.hp = await extractFromCompanyHP(domain);
    emit({ type: 'source_result', source: '会社HP', persons: collected.hp });
  } catch {
    emit({ type: 'source_result', source: '会社HP', persons: [] });
  }

  // ③ Wantedly + LinkedIn + 一般（Yahoo統合検索、1秒ディレイ後）
  emit({ type: 'status', source: 'wantedly', message: '検索中...' });
  emit({ type: 'status', source: 'linkedin', message: '検索中...' });
  await sleep(1000);
  try {
    const combined = await searchPersonsCombined(companyName);
    collected.wantedly = combined.wantedly;
    collected.linkedin = combined.linkedin;
    collected.general  = combined.general;
    emit({ type: 'source_result', source: 'Wantedly', persons: collected.wantedly });
    emit({ type: 'source_result', source: 'LinkedIn', persons: collected.linkedin });
  } catch {
    emit({ type: 'source_result', source: 'Wantedly', persons: [] });
    emit({ type: 'source_result', source: 'LinkedIn', persons: [] });
  }

  // 全ソースをマージして完了
  const persons = mergePersons(Object.values(collected));
  emit({ type: 'done', domain, persons });
}

module.exports = { researchCompany };
