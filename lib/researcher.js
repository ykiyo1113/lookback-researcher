'use strict';
/**
 * web/lib/researcher.js
 * 会社名から担当者を複数ソースで収集するコアモジュール
 * ソース: 会社HP / Wantedly
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));


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

// ─── 会社HP: 全ページクロールで担当者を抽出 ─────────────────────────
async function extractFromCompanyHP(domain, emit) {
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
    if (/recruit|採用|career|careers|jobs|求人/.test(p))         return 8;
    if (/about|company|corporate|会社|企業|概要/.test(p))        return 6;
    if (/contact|お問い合わせ/.test(p))                          return 3;
    return 0; // 低優先度は初期スキャン対象外
  }

  // persons を personMap に追加（重複排除）
  function addPersons(found, sourceUrl) {
    for (const p of found) {
      const key = p.name.replace(/[\s　]/g, '');
      if (!personMap.has(key)) personMap.set(key, { ...p, source: '会社HP', sourceUrl });
    }
  }

  // JSON内を再帰探索して人名らしき文字列を収集
  function extractPersonsFromJsonStr(jsonStr, sourceUrl) {
    // JSONテキストをそのままテキスト抽出にかける
    const persons = extractPersonsFromText([jsonStr]);
    addPersons(persons, sourceUrl);
    if (persons.length > 0) emit({ type: 'log', message: `  → JSON内から${persons.length}名` });
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
    ['/recruit', 8],    ['/careers', 8],     ['/jobs', 8],
    ['/about/recruit', 8], ['/company/recruit', 8], ['/ja/recruit', 8],
    ['/contact', 3],    ['/contact.html', 3], ['/about.html', 6],
    ['/ja/interview', 12], ['/ja/people', 10], ['/ja/team', 8],
    ['/ja/about', 6],   ['/ja/company', 6],
    ['/company/member', 10], ['/company/staff', 10], ['/about/team', 8],
  ]) {
    candidates.set(path, score);
  }

  // ページを取得してテキスト・JSON両方から人名抽出
  function scrapePage($, pageUrl, path) {
    const text = $.text().trim();

    // ① 通常テキスト抽出
    const textPersons = extractPersonsFromText([text]);
    addPersons(textPersons, pageUrl);

    // ② JSON-LD（<script type="application/ld+json">）
    $('script[type="application/ld+json"]').each((_, el) => {
      extractPersonsFromJsonStr($(el).html() || '', pageUrl);
    });

    // ③ Next.js __NEXT_DATA__
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) extractPersonsFromJsonStr(nextData, pageUrl);

    // ④ その他埋め込みJSON（script[type="application/json"]）
    $('script[type="application/json"]').each((_, el) => {
      extractPersonsFromJsonStr($(el).html() || '', pageUrl);
    });

    const totalFound = personMap.size;
    emit({ type: 'log', message: `${path} → ${textPersons.length}名(テキスト), テキスト${text.length}文字${nextData ? ' [Next.js]' : ''}` });
    return totalFound;
  }

  for (const tryUrl of [baseUrl, `https://www.${domain}`]) {
    try {
      await sleep(300);
      emit({ type: 'log', message: `/ にアクセス中...` });
      const res = await axios.get(tryUrl, { headers: HEADERS, timeout: 10000 });
      effectiveBase = tryUrl;
      const $ = cheerio.load(res.data);
      visited.add('/');
      scrapePage($, tryUrl, '/');

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
      emit({ type: 'log', message: `リンク収集: ${candidates.size}件の候補パス` });
      break;
    } catch (e) {
      emit({ type: 'log', message: `/ アクセス失敗: ${e.message}` });
    }
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
      emit({ type: 'log', message: `${path} にアクセス中...` });
      const res = await axios.get(pageUrl, { headers: HEADERS, timeout: 8000 });
      const $ = cheerio.load(res.data);
      scrapePage($, pageUrl, path);

      // インタビュー・メンバー・about/recruit 等からは子ページのリンクも収集
      if (pathScore(path) >= 6) {
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
    } catch (e) {
      emit({ type: 'log', message: `${path} → アクセス失敗` });
    }
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
      emit({ type: 'log', message: `${path} にアクセス中...` });
      const res = await axios.get(pageUrl, { headers: HEADERS, timeout: 8000 });
      const $ = cheerio.load(res.data);
      scrapePage($, pageUrl, path);
    } catch {
      emit({ type: 'log', message: `${path} → アクセス失敗` });
    }
  }

  const result = [...personMap.values()];
  emit({ type: 'log', message: `完了: ${visited.size}ページ確認, ${result.length}名抽出` });
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
async function researchCompany(_companyName, hpUrl, emit) {
  // URL からドメインを抽出
  let domain = null;
  if (hpUrl) {
    try {
      const u = new URL(hpUrl.startsWith('http') ? hpUrl : `https://${hpUrl}`);
      domain = u.hostname.replace(/^www\./, '');
    } catch {
      console.log(`  ⚠️ URL解析失敗: ${hpUrl}`);
    }
  }

  if (domain) {
    emit({ type: 'log', message: `ドメイン: ${domain}` });
  } else {
    emit({ type: 'log', message: 'URLが指定されていません' });
  }

  // 会社HP スクレイピング
  emit({ type: 'status', source: 'hp', message: 'スクレイピング中...' });
  let hpPersons = [];
  try {
    hpPersons = await extractFromCompanyHP(domain, emit);
    emit({ type: 'source_result', source: '会社HP', persons: hpPersons });
  } catch (e) {
    emit({ type: 'log', message: `エラー: ${e.message}` });
    emit({ type: 'source_result', source: '会社HP', persons: [] });
  }

  const persons = mergePersons([hpPersons]);
  emit({ type: 'done', domain, persons });
}

module.exports = { researchCompany };
