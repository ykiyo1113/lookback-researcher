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

// ─── Brave Search API ─────────────────────────────────────────────────
async function braveSearch(query) {
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    headers: {
      'Accept':               'application/json',
      'Accept-Encoding':      'gzip',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
    params: { q: query, count: 10 },
    timeout: 15000,
  });
  return (res.data?.web?.results || []).map(r => ({
    title:   r.title       || '',
    url:     r.url         || '',
    snippet: r.description || '',
  }));
}

// ─── Yahoo Japan 検索ヘルパー（フォールバック用）──────────────────────
async function yahooSearch(query) {
  const url = `https://search.yahoo.co.jp/search?p=${encodeURIComponent(query)}&ei=UTF-8`;
  const res = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 15000 });

  const $ = cheerio.load(res.data);
  const results = [];

  $('div.sw-CardBase').each((_, el) => {
    const href    = $(el).find('a.sw-Card__titleInner').attr('href') || '';
    const title   = $(el).find('.sw-Card__titleMain--clamp').first().text().trim();
    const snippet = $(el).find('.sw-Card__summary').text().trim().replace(/\s+/g, ' ');

    if (!href || href.includes('search.yahoo.co.jp') || href.includes('/image/')) return;
    results.push({ title, url: href, snippet });
  });

  return results;
}

// ─── 統一検索（Brave優先、なければYahoo）────────────────────────────
function webSearch(query) {
  return process.env.BRAVE_API_KEY ? braveSearch(query) : yahooSearch(query);
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

// ─── 会社HP: 全ページクロールで担当者を抽出 ─────────────────────────
async function extractFromCompanyHP(domain) {
  if (!domain) return [];

  const personMap  = new Map(); // key → person (重複排除)
  const visited    = new Set();
  const baseUrl    = `https://${domain}`;
  let   effectiveBase = baseUrl;

  // パスの優先スコア（高いほど先に処理）
  function pathScore(path, linkText = '') {
    const p = (path + ' ' + linkText).toLowerCase();
    if (/interview|インタビュー|story|ストーリー/.test(p))        return 12;
    if (/people|member|メンバー|社員|staff|スタッフ/.test(p))    return 10;
    if (/team|チーム|culture|カルチャー/.test(p))                return 8;
    if (/about|company|corporate|会社|企業|概要/.test(p))        return 6;
    if (/contact|お問い合わせ|recruit|採用/.test(p))             return 4;
    return 0; // 低優先度は初期スキャン対象外
  }

  // persons を personMap に追加（重複排除）
  function addPersons(found, sourceUrl) {
    for (const p of found) {
      const key = p.name.replace(/[\s　]/g, '');
      if (!personMap.has(key)) personMap.set(key, { ...p, source: '会社HP', sourceUrl });
    }
  }

  // ─ Level 0: ホームページ取得 & リンク収集 ─
  const candidates = new Map(); // path → score

  // 事前定義の重要パス
  for (const [path, score] of [
    ['/interview', 12], ['/interviews', 12], ['/interview/', 12],
    ['/story', 12],     ['/stories', 12],
    ['/people', 10],    ['/member', 10],  ['/members', 10],
    ['/team', 8],       ['/staff', 8],    ['/culture', 8],
    ['/about', 6],      ['/company', 6],  ['/corporate', 6],
    ['/about-us', 6],   ['/aboutus', 6],
    ['/contact', 4],    ['/contact.html', 4], ['/about.html', 6],
    ['/ja/interview', 12], ['/ja/people', 10], ['/ja/team', 8],
    ['/ja/about', 6],   ['/ja/company', 6],
    ['/company/member', 10], ['/company/staff', 10], ['/about/team', 8],
  ]) {
    candidates.set(path, score);
  }

  for (const tryUrl of [baseUrl, `https://www.${domain}`]) {
    try {
      await sleep(300);
      const res = await axios.get(tryUrl, { headers: HEADERS, timeout: 10000 });
      effectiveBase = tryUrl;
      const $ = cheerio.load(res.data);
      visited.add('/');
      addPersons(extractPersonsFromText([$.text()]), tryUrl);

      // ホームページのリンクを収集しスコアリング
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();
        try {
          const u = new URL(href, tryUrl);
          if (u.hostname.replace(/^www\./, '') !== domain) return;
          const path = u.pathname;
          if (visited.has(path) || path === '/' || path === '') return;
          const score = pathScore(path, text);
          if (score > 0) candidates.set(path, Math.max(candidates.get(path) || 0, score));
        } catch {}
      });
      break;
    } catch {}
  }

  // ─ Level 1: スコア順に最大20ページをスクレイピング ─
  const sorted = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)
    .slice(0, 20);

  const listingPages = []; // インタビュー一覧など、子ページを持つページ

  for (const path of sorted) {
    if (visited.has(path)) continue;
    visited.add(path);
    const pageUrl = `${effectiveBase}${path}`;
    try {
      await sleep(300);
      const res = await axios.get(pageUrl, { headers: HEADERS, timeout: 8000 });
      const $ = cheerio.load(res.data);
      addPersons(extractPersonsFromText([$.text()]), pageUrl);

      // インタビュー・メンバー一覧ページからは子ページのリンクも収集
      if (pathScore(path) >= 8) {
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          try {
            const u = new URL(href, pageUrl);
            if (u.hostname.replace(/^www\./, '') !== domain) return;
            const childPath = u.pathname;
            if (!visited.has(childPath) && childPath.length > path.length + 1) {
              listingPages.push(childPath);
            }
          } catch {}
        });
      }
    } catch {}
  }

  // ─ Level 2: 一覧ページから発見した個別ページを最大10件クロール ─
  const level2 = [...new Set(listingPages)]
    .filter(p => !visited.has(p))
    .sort((a, b) => pathScore(b) - pathScore(a))
    .slice(0, 10);

  for (const path of level2) {
    visited.add(path);
    const pageUrl = `${effectiveBase}${path}`;
    try {
      await sleep(300);
      const res = await axios.get(pageUrl, { headers: HEADERS, timeout: 8000 });
      const $ = cheerio.load(res.data);
      addPersons(extractPersonsFromText([$.text()]), pageUrl);
    } catch {}
  }

  const result = [...personMap.values()];
  console.log(`  🏢 HP: ${visited.size}ページ確認, ${result.length}名抽出`);
  return result;
}

// ─── Wantedly: 内部検索で担当者を抽出 ────────────────────────────────
async function searchWantedlyDirect(companyName) {
  const persons = [];
  try {
    const searchUrl = `https://www.wantedly.com/search?q=${encodeURIComponent(companyName)}`;
    const res = await axios.get(searchUrl, {
      headers: { ...HEADERS, 'Accept': 'text/html,application/xhtml+xml' },
      timeout: 15000,
    });
    const $ = cheerio.load(res.data);

    // ① Next.js の __NEXT_DATA__ JSON を試す
    let companySlug = null;
    const nextDataText = $('script#__NEXT_DATA__').text();
    if (nextDataText) {
      try {
        const nextData = JSON.parse(nextDataText);
        // 会社スラッグをネストされたJSONから探す
        const json = JSON.stringify(nextData);
        const slugMatch = json.match(/"subdomain"\s*:\s*"([^"]+)"/);
        if (slugMatch) companySlug = slugMatch[1];
        console.log(`  📦 Wantedly __NEXT_DATA__ 取得: slug=${companySlug || 'なし'}`);
      } catch {}
    }

    // ② HTMLから直接プロフィール/会社リンクを探す
    const profileLinks = new Set();
    $('a[href*="/id/"], a[href*="/profiles/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/wantedly\.com\/(id\/|profiles\/)/.test(href) ||
          /^\/id\/|^\/profiles\//.test(href)) {
        profileLinks.add(href);
      }
    });

    // ③ 会社ページURLを探す（/companies/SLUG）
    if (!companySlug) {
      $('a[href*="/companies/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/companies\/([^/?#]+)/);
        if (m && m[1] && !companySlug) companySlug = m[1];
      });
    }

    console.log(`  🔍 Wantedly検索: slug=${companySlug || 'なし'}, プロフィールリンク${profileLinks.size}件`);

    // 会社スラッグが取れた場合、メンバーページを取得
    if (companySlug) {
      for (const membersPath of [
        `/companies/${companySlug}/members`,
        `/companies/${companySlug}`,
      ]) {
        try {
          await sleep(500);
          const membersRes = await axios.get(`https://www.wantedly.com${membersPath}`, {
            headers: HEADERS, timeout: 10000,
          });
          const m$ = cheerio.load(membersRes.data);

          // プロフィールリンクを収集
          m$('a[href*="/id/"], a[href*="/profiles/"]').each((_, el) => {
            const href = m$(el).attr('href') || '';
            profileLinks.add(href);
          });

          // __NEXT_DATA__ からメンバー情報を取得
          const mNextText = m$('script#__NEXT_DATA__').text();
          if (mNextText) {
            try {
              const mData = JSON.parse(mNextText);
              const mJson = JSON.stringify(mData);
              // 名前フィールドを探す
              const names = [...mJson.matchAll(/"name"\s*:\s*"([^"]{2,20})"/g)]
                .map(m => m[1])
                .filter(n => /[一-龯ぁ-んァ-ン]/.test(n) || /^[A-Z][a-z]/.test(n));
              console.log(`  👥 Wantedly メンバー名候補: ${names.slice(0, 5).join(', ')}`);
              for (const name of names.slice(0, 5)) {
                if (!persons.find(p => p.name === name)) {
                  persons.push({ name, role: '', confidence: '○', source: 'Wantedly' });
                }
              }
            } catch {}
          }
          if (persons.length > 0) break;
        } catch (e) {
          console.log(`  ⚠️ Wantedly ${membersPath}: ${e.message}`);
        }
      }
    }

    // プロフィールリンクから名前を解析（タイトルはない→URLのみ）
    // 今後: 個別プロフィールページを取得してタイトルから名前抽出

  } catch (e) {
    console.log(`  ⚠️ Wantedly直接検索エラー: ${e.message}`);
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
    const items = await webSearch(`"${companyName}" prtimes.jp プレスリリース`);

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

  // ③ Wantedly（直接スクレイピング）
  emit({ type: 'status', source: 'wantedly', message: '検索中...' });
  try {
    collected.wantedly = await searchWantedlyDirect(companyName);
    emit({ type: 'source_result', source: 'Wantedly', persons: collected.wantedly });
  } catch {
    emit({ type: 'source_result', source: 'Wantedly', persons: [] });
  }

  // ④ LinkedIn（Brave/Yahoo検索）
  emit({ type: 'status', source: 'linkedin', message: '検索中...' });
  await sleep(1000);
  try {
    const liItems = await webSearch(`"${companyName}" site:linkedin.com/in 広報 OR マーケティング OR 代表取締役`);
    collected.linkedin = liItems
      .filter(i => i.url.includes('linkedin.com/in/'))
      .map(({ title, snippet }) => parseLinkedInTitle(title, snippet))
      .filter(Boolean);
    emit({ type: 'source_result', source: 'LinkedIn', persons: collected.linkedin });
  } catch {
    emit({ type: 'source_result', source: 'LinkedIn', persons: [] });
  }

  // 全ソースをマージして完了
  const persons = mergePersons(Object.values(collected));
  emit({ type: 'done', domain, persons });
}

module.exports = { researchCompany };
