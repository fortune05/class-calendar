'use strict';

// ---------------------------------------------------------------------------
// 설정. API_URL에 Apps Script 웹 앱 URL(README 5단계)을 넣으면 학급 공유 모드가 된다.
// 비워 두면 이 기기에만 저장하는 로컬 모드로 동작한다 (편집 잠금 없음, 샘플 일정으로 시작).
// 편집 비밀번호는 여기에 넣지 않는다. 서버의 스크립트 속성 EDIT_PASSWORD에만 있다.
// ---------------------------------------------------------------------------
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzEqcur1ia_EdQA78Ck_tWqeve3qcoJa-YJpeDWPe7Ifly1fhzC2d8ViQH_kmm28dtB3A/exec',
  SYNC_INTERVAL_MS: 60 * 1000,
  REQUEST_TIMEOUT_MS: 15 * 1000,
};

// 카테고리 정의는 여기 한 곳에만 둔다 (PRD 3.3). CSS의 .cat-<key> 클래스도 이 값으로 만든다.
// - color: PRD 표의 대표색 (테두리·막대·점)
// - bg / text: 라벨용 옅은 배경과 진한 글자색. text는 bg와 화면 배경(#F3F4F6) 위에서 대비 4.5:1 이상
// - icon: 24×24 SVG path. 색이 없어도 모양과 라벨로 구분되게 한다
const CATEGORIES = [
  {
    key: 'notice', name: '일반 공지', label: '공지', color: '#3B82F6', bg: '#DBEAFE', text: '#1E40AF',
    icon: 'M3 10v4a1 1 0 0 0 1 1h3l6 4V5L7 9H4a1 1 0 0 0-1 1z M17 9a4 4 0 0 1 0 6',
  },
  {
    key: 'subject', name: '교과목 공지', label: '교과', color: '#10B981', bg: '#D1FAE5', text: '#065F46',
    icon: 'M3 5h6a3 3 0 0 1 3 2 3 3 0 0 1 3-2h6v13h-6a3 3 0 0 0-3 2 3 3 0 0 0-3-2H3z M12 7v13',
  },
  {
    key: 'exam', name: '평가 공지', label: '평가', color: '#EF4444', bg: '#FEE2E2', text: '#991B1B',
    icon: 'M4 20h4L20 8l-4-4L4 16z M14 6l4 4',
  },
  {
    key: 'event', name: '행사', label: '행사', color: '#8B5CF6', bg: '#EDE9FE', text: '#5B21B6',
    icon: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  },
  {
    key: 'etc', name: '기타', label: '기타', color: '#6B7280', bg: '#E5E7EB', text: '#374151',
    icon: 'M3 12V4h8l10 10-8 8z M7.5 7.5h.01',
  },
];
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
const SVG_NS = 'http://www.w3.org/2000/svg';
// 과목명을 받는 카테고리 (F-02, F-22)
const SUBJECT_CATEGORIES = new Set(['subject', 'exam']);

const STATUS_LABELS = { planned: '예정', inProgress: '진행 중', done: '완료', closed: '마감됨' };
// 편집자가 고를 수 있는 상태 (F-11). 'closed'는 날짜로만 계산된다
const STATUS_OPTIONS = [
  ['auto', '자동'],
  ['planned', '예정'],
  ['inProgress', '진행 중'],
  ['done', '완료'],
];

const LIMITS = { title: 50, subject: 20, description: 500 };

const $ = (selector) => document.querySelector(selector);

// ---------------------------------------------------------------------------
// utils: 날짜 계산과 포맷. 날짜는 'YYYY-MM-DD' 문자열로 다루고,
// 계산은 UTC 자정 기준 ms로 해서 기기 시간대의 영향을 받지 않게 한다.
// ---------------------------------------------------------------------------
const utils = {
  TIME_ZONE: 'Asia/Seoul',
  DAY_MS: 86400000,
  DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
  formatters: new Map(),

  // 서울 기준 시각, 'YYYY-MM-DDTHH:mm'. 기기 시간대와 상관없이 같은 값이 나온다
  nowStr(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  },

  todayStr(date = new Date()) {
    return this.nowStr(date).slice(0, 10);
  },

  toMs(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  },

  toDateStr(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  },

  // month는 0부터 (Date와 같음)
  dateStr(year, month, day) {
    return this.toDateStr(Date.UTC(year, month, day));
  },

  addDays(dateStr, n) {
    return this.toDateStr(this.toMs(dateStr) + n * this.DAY_MS);
  },

  diffDays(from, to) {
    return Math.round((this.toMs(to) - this.toMs(from)) / this.DAY_MS);
  },

  weekday(dateStr) {
    return new Date(this.toMs(dateStr)).getUTCDay();
  },

  uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  },

  dueOf(ev) {
    return ev.dueDate || ev.startDate;
  },

  // 시각이 없는 일정은 그날 끝에 마감되는 것으로 보고 정렬한다
  dueKey(ev) {
    return `${this.dueOf(ev)}T${ev.dueTime || '24:00'}`;
  },

  covers(ev, dateStr) {
    return ev.startDate <= dateStr && dateStr <= this.dueOf(ev);
  },

  isMultiDay(ev) {
    return ev.startDate !== this.dueOf(ev);
  },

  // F-11, F-12: 수동 상태(planned/inProgress/done)는 그대로 돌려주고, 'auto'면 날짜로 계산한다.
  // now는 서울 기준 'YYYY-MM-DDTHH:mm'. 'YYYY-MM-DD'만 주면 마감 시각은 보지 않는다.
  // 마감 시각이 있으면 마감일 당일에도 그 시각부터 마감됨이다.
  getStatus(ev, now) {
    if (ev.status && ev.status !== 'auto') return ev.status;
    const today = now.slice(0, 10);
    const time = now.slice(11);
    const due = this.dueOf(ev);
    if (today > due || (today === due && ev.dueTime && time && time >= ev.dueTime)) return 'closed';
    if (today < ev.startDate) return 'planned';
    return 'inProgress';
  },

  // 마감일까지 남은 일수 (당일 0, 지나면 음수). now와 마감일 모두 서울 기준 달력 날짜로
  // 비교하므로 기기 시간대 때문에 하루 밀리지 않는다.
  getDday(ev, now) {
    return this.diffDays(now.slice(0, 10), this.dueOf(ev));
  },

  isEnded(status) {
    return status === 'done' || status === 'closed';
  },

  // F-13: D-3~D-1 주황, 당일 빨강, 지남 회색. 완료면 배지 없음
  deadlineBadge(ev, now) {
    const status = this.getStatus(ev, now);
    if (status === 'done') return null;
    const n = this.getDday(ev, now);
    if (status === 'closed' || n < 0) return { text: '마감', cls: 'badge-closed' };
    if (n === 0) return { text: 'D-DAY', cls: 'badge-dday' };
    return { text: `D-${n}`, cls: n <= 3 ? 'badge-soon' : 'badge-later' };
  },

  // F-22: 교과·평가 일정은 과목명을 앞에 붙인다
  displayTitle(ev) {
    const prefixed = SUBJECT_CATEGORIES.has(ev.category) && ev.subject;
    return prefixed ? `[${ev.subject}] ${ev.title}` : ev.title;
  },

  // F-05: 폼 값 검증. 필드 이름 → 안내 문구
  validateEvent(values) {
    const errors = {};
    if (!values.title) errors.title = '제목을 입력해 주세요.';
    if (!CATEGORY_MAP[values.category]) errors.category = '카테고리를 골라 주세요.';
    if (!this.DATE_RE.test(values.startDate)) errors.startDate = '시작일을 선택해 주세요.';
    else if (values.dueDate < values.startDate) errors.dueDate = '마감일은 시작일보다 빠를 수 없어요.';
    return errors;
  },

  // 날짜 문자열은 이미 서울 기준 달력 날짜이므로 UTC로 포맷해야 하루가 밀리지 않는다
  format(dateStr, options) {
    const key = JSON.stringify(options);
    if (!this.formatters.has(key)) {
      this.formatters.set(key, new Intl.DateTimeFormat('ko-KR', { ...options, timeZone: 'UTC' }));
    }
    return this.formatters.get(key).format(this.toMs(dateStr));
  },

  // 타임스탬프(ms)는 실제 시각이므로 서울 시간대로 포맷한다
  formatTimestamp(ms) {
    if (!this.timestampFormatter) {
      this.timestampFormatter = new Intl.DateTimeFormat('ko-KR', {
        timeZone: this.TIME_ZONE,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    }
    return this.timestampFormatter.format(ms);
  },

  monthTitle(year, month) {
    return this.format(this.dateStr(year, month, 1), { year: 'numeric', month: 'long' });
  },

  dayLabel(dateStr) {
    return this.format(dateStr, { month: 'long', day: 'numeric', weekday: 'short' });
  },

  shortDate(dateStr) {
    return this.format(dateStr, { month: 'numeric', day: 'numeric' });
  },

  // 마지막 동기화 표시: 오늘이면 'HH:mm', 아니면 '11. 1. HH:mm'
  syncTimeLabel(ms) {
    const at = this.nowStr(new Date(ms));
    const date = at.slice(0, 10);
    return date === this.todayStr() ? at.slice(11) : `${this.shortDate(date)} ${at.slice(11)}`;
  },

  periodText(ev) {
    const due = this.dueOf(ev);
    const range = this.isMultiDay(ev)
      ? `${this.shortDate(ev.startDate)} ~ ${this.shortDate(due)}`
      : this.shortDate(due);
    return ev.dueTime ? `${range} ${ev.dueTime}까지` : range;
  },

  sortEvents(events) {
    return [...events].sort((a, b) =>
      Number(this.isMultiDay(b)) - Number(this.isMultiDay(a)) ||
      a.startDate.localeCompare(b.startDate) ||
      this.dueKey(a).localeCompare(this.dueKey(b)) ||
      a.title.localeCompare(b.title, 'ko'));
  },
};

// ---------------------------------------------------------------------------
// api: Google Apps Script 웹 앱 (apps-script/Code.gs)
// ---------------------------------------------------------------------------

// code는 서버의 error 값과 같고, 브라우저 쪽 실패는 network / offline / storage
class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const ERROR_MESSAGES = {
  unauthorized: '비밀번호가 틀렸어요. 편집 모드가 꺼졌으니 자물쇠 버튼으로 다시 켜 주세요.',
  network: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  offline: '오프라인이라 저장할 수 없어요. 인터넷에 연결된 뒤 다시 시도해 주세요.',
  busy: '다른 사람이 저장하는 중이에요. 잠시 후 다시 시도해 주세요.',
  invalid: '서버가 입력값을 받아들이지 않았어요.',
  not_found: '다른 기기에서 이미 삭제된 일정이에요. 목록을 새로 불러올게요.',
  duplicate: '같은 일정이 이미 있어요. 목록을 새로 불러온 뒤 확인해 주세요.',
  not_configured: '서버에 편집 비밀번호(EDIT_PASSWORD)가 아직 없어요. README 3단계를 확인해 주세요.',
  server: '서버 응답을 읽지 못했어요. 웹 앱 배포 설정(액세스: 모든 사용자)을 확인해 주세요.',
  storage: '이 기기에 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.',
  unknown: '알 수 없는 오류로 저장하지 못했어요.',
};

const api = {
  enabled() {
    return Boolean(CONFIG.API_URL);
  },

  async request(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(CONFIG.API_URL, { ...options, cache: 'no-store', signal: controller.signal });
    } catch (err) {
      throw new ApiError('network');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ApiError('network', `HTTP ${response.status}`);
    let data;
    try {
      data = await response.json();
    } catch (err) {
      // 배포 액세스가 "모든 사용자"가 아니면 JSON 대신 로그인 페이지가 온다
      throw new ApiError('server');
    }
    if (!data || !data.ok) throw new ApiError((data && data.error) || 'server', data && data.message);
    return data;
  },

  // text/plain으로 보내면 CORS 사전 요청(OPTIONS)이 생기지 않는다. Apps Script는 OPTIONS를 받지 못한다
  post(action, payload) {
    return this.request({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
    });
  },

  async fetchEvents() {
    const data = await this.request({ method: 'GET' });
    return data.events;
  },

  // 서버가 createdAt·updatedAt을 정해 돌려준 일정을 반환한다
  async saveEvent(event, password, isNew) {
    const data = await this.post(isNew ? 'create' : 'update', { event, password });
    return data.event;
  },

  async deleteEvent(id, password) {
    await this.post('delete', { event: { id }, password });
  },

  async verifyPassword(password) {
    await this.post('verify', { password });
  },
};

// ---------------------------------------------------------------------------
// store: 메모리 상태 + localStorage.
// 공유 모드에서 classCal.events는 서버 데이터의 캐시이고(원본은 시트), 쓰기는 commitSave·
// commitDelete가 서버에 먼저 반영한 뒤 캐시를 고친다. myDone·filters는 늘 이 기기에만 둔다.
// 편집 비밀번호는 sessionStorage에만 둔다 (탭을 닫으면 사라짐).
// ---------------------------------------------------------------------------
const store = {
  STORAGE_KEY: 'classCal.events',
  MY_DONE_KEY: 'classCal.myDone',
  FILTERS_KEY: 'classCal.filters',
  LAST_SYNC_KEY: 'classCal.lastSync',
  PASSWORD_KEY: 'classCal.editPassword',
  className: '2학년 3반',
  events: [],
  myDone: new Set(),
  editPassword: '',
  lastSync: 0, // 마지막으로 서버 목록을 받은 시각(ms)
  syncState: 'idle', // 'idle' | 'syncing' | 'ok' | 'offline' | 'error'
  revision: 0, // 쓰기마다 증가. 쓰기 전에 출발한 조회 결과로 덮어쓰지 않게 한다
  viewYear: 0,
  viewMonth: 0, // 0부터
  view: 'month', // 'month' | 'list'
  activeCategories: new Set(CATEGORIES.map((c) => c.key)),
  query: '', // 검색어 (F-24). 비어 있지 않으면 목록 뷰가 검색 결과를 보여준다
  selectedDate: null,

  init() {
    this.goToday();
    this.load();
    this.loadMyDone();
    this.loadFilters();
    try {
      this.lastSync = Number(localStorage.getItem(this.LAST_SYNC_KEY)) || 0;
      this.editPassword = sessionStorage.getItem(this.PASSWORD_KEY) || '';
    } catch (err) {
      console.warn('동기화 정보를 불러오지 못했습니다.', err);
    }
  },

  // 저장값이 없으면 (로컬 모드만) 샘플로 시작하고, 읽기·파싱에 실패하면 빈 배열로 복구한다
  load() {
    let raw = null;
    try {
      raw = localStorage.getItem(this.STORAGE_KEY);
    } catch (err) {
      console.warn('일정을 불러오지 못했습니다.', err);
      this.events = [];
      return;
    }
    if (raw === null) {
      this.events = api.enabled() ? [] : createSampleEvents(utils.todayStr());
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      this.events = Array.isArray(parsed) ? parsed.filter(isStoredEvent).map(normalizeEvent) : [];
    } catch (err) {
      console.warn('저장된 일정이 손상되어 비웠습니다.', err);
      this.events = [];
    }
  },

  // 성공 여부를 돌려준다 (사생활 보호 모드·용량 초과 등에서 실패할 수 있음)
  save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.events));
      return true;
    } catch (err) {
      console.warn('일정을 저장하지 못했습니다.', err);
      return false;
    }
  },

  find(id) {
    return this.events.find((ev) => ev.id === id) || null;
  },

  upsert(event) {
    const index = this.events.findIndex((ev) => ev.id === event.id);
    if (index >= 0) this.events[index] = event;
    else this.events.push(event);
    return this.save();
  },

  remove(id) {
    this.events = this.events.filter((ev) => ev.id !== id);
    if (this.myDone.delete(id)) this.saveMyDone();
    return this.save();
  },

  // 서버에서 받은 목록으로 캐시를 바꾼다. 내용이 달라졌는지 돌려준다 (같으면 다시 그리지 않음)
  replaceAll(events) {
    const next = Array.isArray(events) ? events.filter(isStoredEvent).map(normalizeEvent) : [];
    const changed = JSON.stringify(next) !== JSON.stringify(this.events);
    this.events = next;
    this.save();
    this.lastSync = Date.now();
    try {
      localStorage.setItem(this.LAST_SYNC_KEY, String(this.lastSync));
    } catch (err) {
      console.warn('동기화 시각을 저장하지 못했습니다.', err);
    }
    return changed;
  },

  // 공유 모드: 서버가 받아들인 뒤에만 캐시를 고친다. 실패하면 ApiError를 던지고 아무것도 바꾸지 않는다
  async commitSave(event, isNew) {
    if (api.enabled()) {
      const saved = await api.saveEvent(event, this.editPassword, isNew);
      this.upsert(normalizeEvent(saved));
    } else if (!this.upsert(event)) {
      throw new ApiError('storage');
    }
    this.revision++;
  },

  async commitDelete(id) {
    if (api.enabled()) {
      try {
        await api.deleteEvent(id, this.editPassword);
      } catch (err) {
        if (err.code !== 'not_found') throw err; // 이미 지워졌으면 지운 것과 같다
      }
      this.remove(id);
    } else if (!this.remove(id)) {
      throw new ApiError('storage');
    }
    this.revision++;
  },

  setEditPassword(password) {
    this.editPassword = password;
    try {
      if (password) sessionStorage.setItem(this.PASSWORD_KEY, password);
      else sessionStorage.removeItem(this.PASSWORD_KEY);
    } catch (err) {
      console.warn('편집 모드를 기억하지 못했습니다.', err);
    }
  },

  // F-15: 학생 개인 "나 완료" (일정 id 배열). events에는 절대 쓰지 않는다
  loadMyDone() {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.MY_DONE_KEY) || '[]');
      this.myDone = new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
    } catch (err) {
      console.warn('나 완료 체크를 불러오지 못했습니다.', err);
      this.myDone = new Set();
    }
  },

  saveMyDone() {
    try {
      localStorage.setItem(this.MY_DONE_KEY, JSON.stringify([...this.myDone]));
      return true;
    } catch (err) {
      console.warn('나 완료 체크를 저장하지 못했습니다.', err);
      return false;
    }
  },

  isMyDone(id) {
    return this.myDone.has(id);
  },

  setMyDone(id, done) {
    if (done) this.myDone.add(id);
    else this.myDone.delete(id);
    return this.saveMyDone();
  },

  goToday() {
    const today = utils.todayStr();
    this.viewYear = Number(today.slice(0, 4));
    this.viewMonth = Number(today.slice(5, 7)) - 1;
    this.selectedDate = null;
  },

  shiftMonth(delta) {
    const d = new Date(Date.UTC(this.viewYear, this.viewMonth + delta, 1));
    this.viewYear = d.getUTCFullYear();
    this.viewMonth = d.getUTCMonth();
    this.selectedDate = null;
  },

  // F-21: 켜 둔 카테고리 key 배열. 저장값이 없으면 전부 켠다
  loadFilters() {
    try {
      const raw = localStorage.getItem(this.FILTERS_KEY);
      if (raw === null) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.activeCategories = new Set(parsed.filter((key) => CATEGORY_MAP[key]));
    } catch (err) {
      console.warn('필터 설정을 불러오지 못했습니다.', err);
    }
  },

  saveFilters() {
    try {
      localStorage.setItem(this.FILTERS_KEY, JSON.stringify([...this.activeCategories]));
    } catch (err) {
      console.warn('필터 설정을 저장하지 못했습니다.', err);
    }
  },

  toggleCategory(key) {
    if (this.activeCategories.has(key)) this.activeCategories.delete(key);
    else this.activeCategories.add(key);
    this.saveFilters();
  },

  showAllCategories() {
    this.activeCategories = new Set(CATEGORIES.map((c) => c.key));
    this.saveFilters();
  },

  allCategoriesOn() {
    return this.activeCategories.size === CATEGORIES.length;
  },

  visibleEvents() {
    return this.events.filter((ev) => this.activeCategories.has(ev.category));
  },

  // F-24: 제목·내용·과목에서 대소문자 구분 없이 찾는다. 카테고리 필터도 함께 적용
  searchResults() {
    const q = this.query.toLowerCase();
    return this.visibleEvents().filter((ev) =>
      [ev.title, ev.description, ev.subject].some((text) => text.toLowerCase().includes(q)));
  },

  eventsOn(dateStr) {
    return utils.sortEvents(this.visibleEvents().filter((ev) => utils.covers(ev, dateStr)));
  },
};

// 화면을 깨뜨릴 수 있는 손상된 항목은 버린다
function isStoredEvent(ev) {
  return Boolean(ev) && typeof ev === 'object' &&
    typeof ev.id === 'string' &&
    typeof ev.title === 'string' &&
    Boolean(CATEGORY_MAP[ev.category]) &&
    typeof ev.startDate === 'string' && utils.DATE_RE.test(ev.startDate);
}

function normalizeEvent(ev) {
  const str = (value) => (typeof value === 'string' ? value : '');
  return {
    ...ev,
    subject: str(ev.subject),
    dueDate: utils.DATE_RE.test(str(ev.dueDate)) ? ev.dueDate : ev.startDate,
    dueTime: str(ev.dueTime),
    description: str(ev.description),
    status: STATUS_OPTIONS.some(([value]) => value === ev.status) ? ev.status : 'auto',
    createdAt: Number(ev.createdAt) || 0,
    updatedAt: Number(ev.updatedAt) || 0,
  };
}

// 언제 열어도 이번 주 마감과 여러 날 일정이 보이도록 오늘 기준 상대 날짜로 만든다
function createSampleEvents(today) {
  const d = (n) => utils.addDays(today, n);
  const now = Date.now();
  const make = (fields) => ({
    id: utils.uuid(),
    subject: '',
    dueDate: fields.startDate,
    dueTime: '',
    description: '',
    status: 'auto',
    createdAt: now,
    updatedAt: now,
    ...fields,
  });

  return [
    make({ title: '현장체험학습 동의서 회신', category: 'notice', startDate: d(-25), description: '가정통신문 회신서를 담임 선생님께 제출' }),
    make({ title: '체육대회', category: 'event', startDate: d(-18), description: '체육복 착용, 오전 9시 운동장 집합' }),
    make({ title: '단어 시험 범위 공지', category: 'subject', subject: '영어', startDate: d(-3), description: 'Lesson 5~6 본문 단어' }),
    make({ title: '학급 축제 준비 주간', category: 'event', startDate: d(-1), dueDate: d(3), description: '방과 후 교실 꾸미기, 역할 분담표 확인' }),
    make({ title: '수행평가 2차 보고서 제출', category: 'exam', subject: '수학', startDate: d(0), dueTime: '16:30', description: 'A4 2장, 교무실 제출' }),
    make({ title: '청소 구역 교대', category: 'notice', startDate: d(0), description: '이번 주부터 2분단이 복도 담당' }),
    make({ title: '분실물 찾아가기', category: 'etc', startDate: d(0), description: '교탁 옆 상자, 금요일에 정리 예정' }),
    make({ title: '독서 감상문 제출', category: 'subject', subject: '국어', startDate: d(1), dueTime: '09:00', description: '원고지 5매 이상' }),
  ];
}

// ---------------------------------------------------------------------------
// render: 상태 → DOM. 사용자 입력은 모두 textContent로 넣는다 (XSS 방지).
// 일정을 여는 요소에는 data-event-id를 붙이고, 클릭은 ui에서 위임 처리한다.
// ---------------------------------------------------------------------------
const render = {
  h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  },

  eventButton(ev, className) {
    const button = this.h('button', className);
    button.type = 'button';
    button.dataset.eventId = ev.id;
    return button;
  },

  all() {
    this.header();
    this.editMode();
    this.syncStatus();
    this.filters();
    this.upcoming();
    this.month();
    this.list();
  },

  // 편집 모드가 아니면 body.can-edit이 빠져 .edit-only(추가·수정·삭제·상태·내보내기)가 숨는다
  editMode() {
    const editing = Boolean(store.editPassword);
    document.body.classList.toggle('can-edit', ui.canEdit());
    const lock = $('#lock-btn');
    lock.hidden = !api.enabled();
    lock.setAttribute('aria-pressed', String(editing));
    lock.title = editing ? '편집 모드 끄기' : '편집 모드 켜기 (비밀번호 필요)';
    $('#lock-label').textContent = editing ? '편집 중' : '편집';
  },

  syncStatus() {
    const el = $('#sync-status');
    if (!api.enabled()) {
      el.textContent = '이 기기에만 저장 중';
      el.dataset.state = 'local';
      return;
    }
    const last = store.lastSync ? `마지막 동기화: ${utils.syncTimeLabel(store.lastSync)}` : '아직 동기화 전';
    const prefix = { syncing: '동기화 중… · ', offline: '오프라인 · ', error: '연결 실패 · ' }[store.syncState] || '';
    el.textContent = prefix + last;
    el.dataset.state = store.syncState;
  },

  // CATEGORIES에서 .cat-<key> { --c, --c-bg, --c-text } 규칙을 만든다 (상수 값만 들어간다)
  categoryStyles() {
    const style = document.createElement('style');
    style.textContent = CATEGORIES
      .map((c) => `.cat-${c.key} { --c: ${c.color}; --c-bg: ${c.bg}; --c-text: ${c.text}; }`)
      .join('\n');
    document.head.append(style);
  },

  icon(cat) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'cat-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', cat.icon);
    svg.append(path);
    return svg;
  },

  header() {
    $('#class-name').textContent = store.className;
    $('#month-title').textContent = utils.monthTitle(store.viewYear, store.viewMonth);
    document.title = `${store.className} 캘린더`;
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === store.view));
    }
    $('#month-view').hidden = store.view !== 'month';
    $('#list-view').hidden = store.view !== 'list';
  },

  filters() {
    for (const chip of document.querySelectorAll('.chip[data-category]')) {
      chip.setAttribute('aria-pressed', String(store.activeCategories.has(chip.dataset.category)));
    }
    $('#chip-all').setAttribute('aria-pressed', String(store.allCategoriesOn()));
  },

  catTag(ev) {
    const cat = CATEGORY_MAP[ev.category];
    const tag = this.h('span', `cat-tag cat-${ev.category}`);
    tag.append(this.icon(cat), this.h('span', '', cat.label));
    return tag;
  },

  badge(info) {
    return this.h('span', `badge ${info.cls}`, info.text);
  },

  // F-16: 오늘~7일 뒤 마감, 완료·마감되지 않았고 내가 완료 체크하지 않은 일정
  upcoming() {
    const listEl = $('#upcoming-list');
    const now = utils.nowStr();
    const items = store.visibleEvents()
      .filter((ev) => {
        const dday = utils.getDday(ev, now);
        return dday >= 0 && dday <= 7 &&
          !utils.isEnded(utils.getStatus(ev, now)) &&
          !store.isMyDone(ev.id);
      })
      .sort((a, b) => utils.dueKey(a).localeCompare(utils.dueKey(b)));

    listEl.replaceChildren();
    if (items.length === 0) {
      listEl.append(this.h('li', 'upcoming-empty', this.emptyText('7일 안에 마감이 없어요.')));
      return;
    }
    for (const ev of items) {
      const card = this.eventButton(ev, `upcoming-card cat-${ev.category}`);
      const top = this.h('span', 'card-top');
      top.append(this.catTag(ev), this.badge(utils.deadlineBadge(ev, now)));
      const due = utils.dayLabel(utils.dueOf(ev)) + (ev.dueTime ? ` ${ev.dueTime}` : '');
      card.append(top, this.h('span', 'card-title', utils.displayTitle(ev)), this.h('span', 'card-due', `${due} 마감`));
      const li = this.h('li', 'upcoming-item');
      li.append(card);
      listEl.append(li);
    }
  },

  bar(ev, dateStr, now) {
    const cat = CATEGORY_MAP[ev.category];
    const classes = ['bar', `cat-${ev.category}`];
    if (utils.isEnded(utils.getStatus(ev, now))) classes.push('is-ended');
    if (dateStr > ev.startDate) classes.push('cont-left');
    if (dateStr < utils.dueOf(ev)) classes.push('cont-right');
    const bar = this.eventButton(ev, classes.join(' '));
    const title = utils.displayTitle(ev);
    bar.title = `${cat.label} · ${title}`;
    bar.setAttribute('aria-label', `${cat.label}: ${title}`);
    bar.append(this.icon(cat), this.h('span', 'bar-label', cat.label), this.h('span', 'bar-text', title));
    return bar;
  },

  // 모든 카테고리를 꺼서 비었을 때는 그 이유를 알려준다
  emptyText(text) {
    return store.activeCategories.size === 0 ? "모든 카테고리가 꺼져 있어요. '전체'를 눌러 주세요." : text;
  },

  month() {
    const grid = $('#month-grid');
    const { viewYear: year, viewMonth: month } = store;
    const first = utils.dateStr(year, month, 1);
    const lead = utils.weekday(first);
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const cellCount = Math.ceil((lead + daysInMonth) / 7) * 7;
    const gridStart = utils.addDays(first, -lead);
    const monthPrefix = first.slice(0, 7);
    const now = utils.nowStr();
    const today = now.slice(0, 10);

    grid.replaceChildren();
    for (let i = 0; i < cellCount; i++) {
      const date = utils.addDays(gridStart, i);
      const events = store.eventsOn(date);
      const classes = ['day'];
      if (i % 7 === 0) classes.push('sun');
      if (i % 7 === 6) classes.push('sat');
      if (!date.startsWith(monthPrefix)) classes.push('other-month');
      if (date === today) classes.push('today');
      if (date === store.selectedDate) classes.push('selected');

      const cell = this.h('div', classes.join(' '));
      cell.dataset.date = date;

      const list = this.h('div', 'day-events');
      for (const ev of events.slice(0, 3)) list.append(this.bar(ev, date, now));
      if (events.length > 3) list.append(this.h('span', 'more', `+${events.length - 3}`));

      cell.append(this.h('span', 'day-num', String(Number(date.slice(8)))), list);
      grid.append(cell);
    }
    this.dayPanel();
  },

  // 모바일 월간 뷰: 누른 날짜의 일정 목록 (데스크탑에서는 CSS로 숨김)
  dayPanel() {
    const panel = $('#day-panel');
    panel.replaceChildren();
    panel.hidden = !store.selectedDate;
    if (!store.selectedDate) return;

    const now = utils.nowStr();
    const events = store.eventsOn(store.selectedDate);
    const head = this.h('div', 'day-panel-head');
    const add = this.h('button', 'text-btn edit-only', '+ 이날 일정 추가');
    add.type = 'button';
    add.dataset.addDate = store.selectedDate;
    head.append(this.h('h3', 'day-panel-title', utils.dayLabel(store.selectedDate)), add);
    panel.append(head);

    if (events.length === 0) {
      panel.append(this.h('p', 'list-empty', '이날은 일정이 없어요.'));
      return;
    }
    const ul = this.h('ul', 'event-list');
    for (const ev of events) ul.append(this.eventItem(ev, now));
    panel.append(ul);
  },

  eventItem(ev, now) {
    const status = utils.getStatus(ev, now);
    const button = this.eventButton(ev, `event-item cat-${ev.category}${utils.isEnded(status) ? ' is-ended' : ''}`);

    const body = this.h('span', 'event-body');
    body.append(this.h('span', 'event-title', utils.displayTitle(ev)), this.h('span', 'event-meta', utils.periodText(ev)));

    const badges = this.h('span', 'event-badges');
    badges.append(this.h('span', 'badge badge-status', STATUS_LABELS[status]));
    if (!utils.isEnded(status)) badges.append(this.badge(utils.deadlineBadge(ev, now)));

    button.append(this.catTag(ev), body, badges);
    // 체크박스는 버튼 안에 넣을 수 없어 옆에 둔다
    const li = this.h('li', `event-row${store.isMyDone(ev.id) ? ' is-my-done' : ''}`);
    li.append(button, this.myDoneToggle(ev));
    return li;
  },

  // F-15: 학생 개인 체크. 변경은 ui에서 위임 처리한다
  myDoneToggle(ev) {
    const label = this.h('label', 'my-done');
    const input = this.h('input');
    input.type = 'checkbox';
    input.dataset.myDone = ev.id;
    input.checked = store.isMyDone(ev.id);
    input.setAttribute('aria-label', `나 완료: ${utils.displayTitle(ev)}`);
    label.append(input, this.h('span', '', '나 완료'));
    return label;
  },

  // 날짜별 그룹. 여러 날 일정은 이번 달 안에서 처음 걸치는 날에 한 번만 넣는다.
  // 검색 중이면 달과 상관없이 검색 결과를 시작일별로 묶는다.
  list() {
    const container = $('#list-view');
    container.replaceChildren();
    const groups = new Map();
    const addTo = (key, ev) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    };

    if (store.query) {
      const results = store.searchResults();
      for (const ev of results) addTo(ev.startDate, ev);
      container.append(this.searchSummary(results.length));
      if (results.length === 0) {
        container.append(this.h('p', 'list-empty', this.emptyText('검색 결과가 없어요.')));
        return;
      }
    } else {
      const { viewYear: year, viewMonth: month } = store;
      const monthStart = utils.dateStr(year, month, 1);
      const monthEnd = utils.dateStr(year, month + 1, 0);
      for (const ev of store.visibleEvents()) {
        if (ev.startDate > monthEnd || utils.dueOf(ev) < monthStart) continue;
        addTo(ev.startDate < monthStart ? monthStart : ev.startDate, ev);
      }
      if (groups.size === 0) {
        container.append(this.h('p', 'list-empty', this.emptyText('이번 달 일정이 없어요.')));
        return;
      }
    }

    const now = utils.nowStr();
    const today = now.slice(0, 10);
    for (const date of [...groups.keys()].sort()) {
      const section = this.h('section', 'list-group');
      const wd = utils.weekday(date);
      const heading = this.h('h3', `list-date${wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''}`, utils.dayLabel(date));
      if (date === today) heading.append(this.h('span', 'today-tag', '오늘'));

      const ul = this.h('ul', 'event-list');
      for (const ev of utils.sortEvents(groups.get(date))) ul.append(this.eventItem(ev, now));
      section.append(heading, ul);
      container.append(section);
    }
  },

  searchSummary(count) {
    const wrap = this.h('div', 'search-summary');
    const filterNote = store.allCategoriesOn() ? '' : ' (필터 적용 중)';
    const text = this.h('p', '', `'${store.query}' 검색 결과 ${count}개${filterNote}`);
    text.setAttribute('role', 'status');
    const clear = this.h('button', 'text-btn', '검색 지우기');
    clear.type = 'button';
    clear.dataset.clearSearch = '';
    wrap.append(text, clear);
    return wrap;
  },

  // 상세 모달 본문 (F-03, F-07) + 상태 선택(F-11)·나 완료(F-15) 표시
  detail(ev) {
    const now = utils.nowStr();
    const status = utils.getStatus(ev, now);
    const chosen = ev.status || 'auto';
    for (const button of document.querySelectorAll('#status-buttons [data-status]')) {
      button.setAttribute('aria-pressed', String(button.dataset.status === chosen));
    }
    $('#status-hint').textContent = chosen === 'auto'
      ? `날짜로 계산해요. 지금은 '${STATUS_LABELS[status]}'이에요.`
      : '편집자가 직접 정한 상태예요.';
    $('#detail-my-done').checked = store.isMyDone(ev.id);
    const wrap = $('#detail-content');
    wrap.replaceChildren();

    const badges = this.h('div', 'detail-badges');
    badges.append(this.catTag(ev), this.h('span', 'badge badge-status', STATUS_LABELS[status]));
    if (!utils.isEnded(status)) badges.append(this.badge(utils.deadlineBadge(ev, now)));

    const meta = this.h('dl', 'detail-meta');
    const addMeta = (term, value) => meta.append(this.h('dt', '', term), this.h('dd', '', value));
    addMeta('기간', utils.periodText(ev));
    if (SUBJECT_CATEGORIES.has(ev.category) && ev.subject) addMeta('과목', ev.subject);

    const desc = ev.description
      ? this.h('p', 'detail-desc', ev.description)
      : this.h('p', 'detail-desc is-empty', '내용 없음');

    wrap.append(badges, meta, desc);
    if (ev.updatedAt) wrap.append(this.h('p', 'detail-updated', `마지막 수정: ${utils.formatTimestamp(ev.updatedAt)}`));
  },
};

// ---------------------------------------------------------------------------
// ui: 이벤트 연결, 모달 열기·닫기, 폼 검증
// ---------------------------------------------------------------------------
const ui = {
  wide: window.matchMedia('(min-width: 768px)'),
  print: window.matchMedia('print'),
  lastFocus: null,
  detailId: null, // 상세 보기 중인 일정
  editingId: null, // 수정 중인 일정 (추가일 때는 null)
  viewBeforeSearch: null,
  toastTimer: 0,
  searchTimer: 0,
  saving: false, // 서버에 쓰는 중이면 모달을 닫거나 다시 조회하지 않는다
  syncing: false,

  // 로컬 모드는 지킬 공유 데이터가 없으니 늘 편집 가능. 공유 모드는 비밀번호를 넣은 탭만
  canEdit() {
    return !api.enabled() || Boolean(store.editPassword);
  },

  init() {
    store.view = this.wide.matches ? 'month' : 'list';
    this.wide.addEventListener('change', (e) => {
      // 인쇄 미리보기도 폭이 바뀌므로 그때는 보기를 바꾸지 않는다. 검색 중에는 목록 유지
      if (this.print.matches || store.query) return;
      store.view = e.matches ? 'month' : 'list';
      render.all();
    });

    $('#prev-month').addEventListener('click', () => {
      store.shiftMonth(-1);
      render.all();
    });
    $('#next-month').addEventListener('click', () => {
      store.shiftMonth(1);
      render.all();
    });
    $('#today-btn').addEventListener('click', () => {
      store.goToday();
      render.all();
    });
    $('#add-btn').addEventListener('click', () => {
      this.openForm({ startDate: store.selectedDate || utils.todayStr() });
    });
    $('#lock-btn').addEventListener('click', () => this.toggleEditMode());
    $('#export-btn').addEventListener('click', () => this.exportJson());

    for (const tab of document.querySelectorAll('[role="tab"]')) {
      tab.addEventListener('click', () => {
        store.view = tab.dataset.view;
        render.header();
      });
    }

    this.initFilters();
    this.initSearch();
    this.initForm();
    this.initModal();

    $('main').addEventListener('click', (e) => this.handleMainClick(e));
    $('main').addEventListener('change', (e) => {
      const id = e.target.dataset && e.target.dataset.myDone;
      if (id) this.setMyDone(id, e.target.checked);
    });

    // 자정이 지나거나 마감 시각이 지나도 상태·D-n이 맞도록, 화면이 다시 보일 때 새로 그리고
    // 서버에서 다시 받아온다. 화면이 보이는 동안에는 60초마다 조회한다.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      render.all();
      this.refreshDetail();
      this.sync();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') this.sync();
    }, CONFIG.SYNC_INTERVAL_MS);
    window.addEventListener('online', () => this.sync());
    window.addEventListener('offline', () => {
      store.syncState = 'offline';
      render.syncStatus();
    });
  },

  // ---- 동기화 (PRD 6.2) ----
  // 캐시는 이미 그려져 있고, 서버 목록으로 바꾼 뒤 달라졌을 때만 다시 그린다
  async sync() {
    if (!api.enabled() || this.syncing || this.saving) return;
    if (!navigator.onLine) {
      store.syncState = 'offline';
      render.syncStatus();
      return;
    }
    this.syncing = true;
    store.syncState = 'syncing';
    render.syncStatus();
    const revision = store.revision;
    try {
      const events = await api.fetchEvents();
      store.syncState = 'ok';
      // 조회하는 동안 이 기기에서 저장했다면 이 결과는 낡았으니 버리고 다음 조회를 기다린다
      if (revision === store.revision && store.replaceAll(events)) {
        render.all();
        this.refreshDetail();
      }
    } catch (err) {
      store.syncState = navigator.onLine ? 'error' : 'offline';
      console.warn('동기화하지 못했습니다.', err);
    } finally {
      this.syncing = false;
      render.syncStatus();
    }
  },

  // 열려 있는 상세를 최신 데이터로 다시 그린다. 다른 기기에서 지워졌으면 닫는다
  refreshDetail() {
    if (!this.detailId || this.saving) return;
    const ev = store.find(this.detailId);
    if (ev) {
      render.detail(ev);
      $('#modal-title').textContent = utils.displayTitle(ev);
    } else {
      this.closeModal();
      this.toast('다른 기기에서 삭제된 일정이에요.');
    }
  },

  // ---- 편집 모드 ----
  toggleEditMode() {
    if (store.editPassword) {
      store.setEditPassword('');
      render.all();
      this.toast('편집 모드를 껐어요.');
      return;
    }
    $('#password-form').reset();
    this.clearError($('#f-password'));
    this.detailId = null;
    this.editingId = null;
    this.showPane('password');
    this.openModal('편집 모드 켜기');
    $('#f-password').focus();
  },

  // 비밀번호는 서버에서 확인한 뒤에만 sessionStorage에 둔다
  async submitPassword(e) {
    e.preventDefault();
    const input = $('#f-password');
    const password = input.value;
    if (!password) {
      this.showError(input, '비밀번호를 입력해 주세요.');
      input.focus();
      return;
    }
    const ok = await this.runWrite($('#password-submit'), () => api.verifyPassword(password), {
      busyLabel: '확인 중…',
      onError: (err) => {
        this.showError(input, err.code === 'unauthorized' ? '비밀번호가 틀렸어요.' : this.errorMessage(err));
        return true;
      },
    });
    if (!ok) {
      input.focus();
      return;
    }
    store.setEditPassword(password);
    this.closeModal();
    render.all();
    this.toast('편집 모드를 켰어요. 이 탭을 닫으면 꺼져요.');
  },

  // PRD 7장 백업: 지금 보이는 데이터(공유 모드면 마지막으로 받은 서버 목록)를 내려받는다
  exportJson() {
    const json = JSON.stringify(store.events, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `class-calendar-${utils.todayStr()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // ---- 서버 쓰기 ----
  // 쓰는 동안 모달의 버튼·입력을 잠그고 누른 버튼에 "저장 중…"을 띄운다.
  // 실패하면 아무것도 바꾸지 않고(원래 상태 유지) 원인을 모달에 알린다. 성공 여부를 돌려준다.
  async runWrite(button, task, { busyLabel = '저장 중…', onError = null } = {}) {
    const errorEl = $('#write-error');
    errorEl.hidden = true;
    if (api.enabled() && !navigator.onLine) {
      const err = new ApiError('offline');
      if (!(onError && onError(err))) this.showWriteError(err);
      return false;
    }

    const dialog = $('.modal-dialog');
    const controls = [...dialog.querySelectorAll('button, input, select, textarea')];
    const wasDisabled = controls.map((el) => el.disabled);
    const focused = document.activeElement;
    const label = button.textContent;
    this.saving = true;
    dialog.setAttribute('aria-busy', 'true');
    for (const el of controls) el.disabled = true;
    button.textContent = busyLabel;
    try {
      await task();
      return true;
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      if (!(onError && onError(err))) this.showWriteError(err);
      return false;
    } finally {
      this.saving = false;
      dialog.removeAttribute('aria-busy');
      controls.forEach((el, i) => {
        el.disabled = wasDisabled[i];
      });
      button.textContent = label;
      if (!$('#modal').hidden && dialog.contains(focused)) focused.focus();
    }
  },

  errorMessage(err) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    const message = ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown;
    return code === 'invalid' && err.message ? `${message} (${err.message})` : message;
  },

  showWriteError(err) {
    const errorEl = $('#write-error');
    errorEl.textContent = this.errorMessage(err);
    errorEl.hidden = false;
    if (err.code === 'unauthorized') {
      // 서버 비밀번호가 바뀌었거나 틀렸다. 편집 모드를 끄고 다시 넣게 한다
      store.setEditPassword('');
      render.all();
    }
    if (err.code === 'not_found' || err.code === 'duplicate') this.sync();
  },

  // 다시 그리지 않고 같은 일정의 체크박스만 맞춰서, 누른 체크박스의 포커스를 지킨다
  setMyDone(id, done) {
    const ok = store.setMyDone(id, done);
    for (const input of document.querySelectorAll('[data-my-done]')) {
      if (input.dataset.myDone !== id) continue;
      input.checked = done;
      input.closest('.event-row').classList.toggle('is-my-done', done);
    }
    if (this.detailId === id) $('#detail-my-done').checked = done;
    render.upcoming();
    if (!ok) this.toast('이 기기에 저장하지 못했어요.');
  },

  // 실패하면 눌린 버튼(aria-pressed)이 그대로라 원래 상태가 유지된다
  async setStatus(status) {
    const ev = store.find(this.detailId);
    if (!ev || !this.canEdit() || (ev.status || 'auto') === status) return;
    const button = [...document.querySelectorAll('#status-buttons [data-status]')].find((b) => b.dataset.status === status);
    const ok = await this.runWrite(button, () => store.commitSave({ ...ev, status, updatedAt: Date.now() }, false));
    if (!ok) return;
    render.all();
    this.refreshDetail();
  },

  // 일정 → 상세, 데스크탑 날짜 칸 → 추가, 모바일 날짜 칸 → 그날 목록 펼치기
  handleMainClick(e) {
    const item = e.target.closest('[data-event-id]');
    if (item) {
      this.openDetail(item.dataset.eventId);
      return;
    }
    const add = e.target.closest('[data-add-date]');
    if (add) {
      this.openForm({ startDate: add.dataset.addDate });
      return;
    }
    if (e.target.closest('[data-clear-search]')) {
      this.clearSearch();
      return;
    }
    const cell = e.target.closest('.day');
    if (!cell) return;
    if (this.wide.matches) {
      if (this.canEdit()) this.openForm({ startDate: cell.dataset.date });
    } else {
      store.selectedDate = store.selectedDate === cell.dataset.date ? null : cell.dataset.date;
      render.month();
    }
  },

  // F-21: "전체" + 카테고리 칩 5개 (aria-pressed로 켜짐 표시)
  initFilters() {
    const wrap = $('#filter-chips');
    const all = render.h('button', 'chip chip-all', '전체');
    all.type = 'button';
    all.id = 'chip-all';
    all.addEventListener('click', () => {
      store.showAllCategories();
      render.all();
    });
    wrap.append(all);

    for (const cat of CATEGORIES) {
      const chip = render.h('button', `chip cat-${cat.key}`);
      chip.type = 'button';
      chip.dataset.category = cat.key;
      chip.title = cat.name;
      chip.append(render.icon(cat), render.h('span', '', cat.label));
      chip.addEventListener('click', () => {
        store.toggleCategory(cat.key);
        render.all();
      });
      wrap.append(chip);
    }
  },

  // F-24: 입력이 200ms 멈추면 검색한다
  initSearch() {
    const input = $('#search-input');
    input.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.applySearch(input.value), 200);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        this.clearSearch();
      }
    });
  },

  // 검색을 시작하면 목록 뷰로 바꾸고, 지우면 원래 보기로 돌아간다
  applySearch(value) {
    const query = value.trim();
    if (query === store.query) return;
    if (query && !store.query) this.viewBeforeSearch = store.view;
    store.query = query;
    if (query) {
      store.view = 'list';
    } else if (this.viewBeforeSearch) {
      store.view = this.viewBeforeSearch;
      this.viewBeforeSearch = null;
    }
    render.header();
    render.list();
  },

  clearSearch() {
    clearTimeout(this.searchTimer);
    const input = $('#search-input');
    input.value = '';
    this.applySearch('');
    input.focus();
  },

  // ---- 모달 공통 ----
  initModal() {
    const modal = $('#modal');
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') && !this.saving) this.closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (modal.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!this.saving) this.closeModal();
      } else if (e.key === 'Tab') {
        this.trapFocus(e);
      }
    });

    const statusButtons = $('#status-buttons');
    for (const [value, label] of STATUS_OPTIONS) {
      const button = render.h('button', 'segment', label);
      button.type = 'button';
      button.dataset.status = value;
      button.addEventListener('click', () => this.setStatus(value));
      statusButtons.append(button);
    }
    $('#detail-my-done').addEventListener('change', (e) => this.setMyDone(this.detailId, e.target.checked));

    $('#edit-btn').addEventListener('click', () => this.openForm({ id: this.detailId }));
    $('#delete-btn').addEventListener('click', () => this.showDeleteConfirm(true));
    $('#delete-cancel').addEventListener('click', () => this.showDeleteConfirm(false));
    $('#delete-ok').addEventListener('click', () => this.deleteCurrent());

    $('#password-form').addEventListener('submit', (e) => this.submitPassword(e));
    $('#password-form').addEventListener('input', (e) => this.clearError(e.target));
    $('#password-cancel').addEventListener('click', () => this.closeModal());
  },

  openModal(title) {
    const modal = $('#modal');
    if (modal.hidden) this.lastFocus = document.activeElement;
    $('#write-error').hidden = true;
    $('#modal-title').textContent = title;
    modal.hidden = false;
    document.body.classList.add('modal-open');
  },

  closeModal() {
    $('#modal').hidden = true;
    document.body.classList.remove('modal-open');
    this.detailId = null;
    this.editingId = null;
    this.restoreFocus();
  },

  // 모달을 연 요소로 포커스를 돌려준다. 저장 후 다시 그려서 그 요소가 바뀌었으면
  // 같은 일정·같은 종류(막대/목록/카드)의 새 요소를 찾고, 없으면(삭제 등) "+ 일정"으로 보낸다.
  restoreFocus() {
    const opener = this.lastFocus;
    this.lastFocus = null;
    if (!opener || opener === document.body) return;
    let target = opener;
    if (!document.contains(opener)) {
      const id = opener.dataset && opener.dataset.eventId;
      const kind = opener.classList[0];
      target = [...document.querySelectorAll('[data-event-id]')].find((el) =>
        el.dataset.eventId === id && el.classList.contains(kind) && el.getClientRects().length > 0) || $('#add-btn');
    }
    target.focus();
  },

  showPane(name) {
    $('#detail-view').hidden = name !== 'detail';
    $('#event-form').hidden = name !== 'form';
    $('#password-form').hidden = name !== 'password';
  },

  // 모달 안에서만 Tab이 돌게 한다
  trapFocus(e) {
    const focusables = [...$('.modal-dialog').querySelectorAll('button, input, select, textarea')]
      .filter((el) => !el.disabled && el.getClientRects().length > 0);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  },

  // ---- 상세 보기 ----
  openDetail(id) {
    const ev = store.find(id);
    if (!ev) return;
    this.detailId = id;
    this.editingId = null;
    render.detail(ev);
    this.showDeleteConfirm(false);
    this.showPane('detail');
    this.openModal(utils.displayTitle(ev));
    // 열람자에게는 수정 버튼이 없으니 "나 완료"에 포커스를 둔다
    (this.canEdit() ? $('#edit-btn') : $('#detail-my-done')).focus();
  },

  showDeleteConfirm(show) {
    $('#detail-actions').hidden = show;
    $('#delete-confirm').hidden = !show;
    if (show) $('#delete-cancel').focus();
    else if (!$('#modal').hidden) $('#edit-btn').focus();
  },

  async deleteCurrent() {
    const id = this.detailId;
    if (!id || !this.canEdit()) return;
    const ok = await this.runWrite($('#delete-ok'), () => store.commitDelete(id));
    if (!ok) return;
    this.closeModal();
    render.all();
    this.toast('삭제했어요.');
  },

  // ---- 추가·수정 폼 ----
  initForm() {
    const select = $('#f-category');
    for (const cat of CATEGORIES) {
      const option = render.h('option', '', `${cat.label} (${cat.name})`);
      option.value = cat.key;
      select.append(option);
    }
    select.addEventListener('change', () => this.updateSubjectField());

    const desc = $('#f-desc');
    desc.addEventListener('input', () => this.updateDescCount());

    const form = $('#event-form');
    form.addEventListener('submit', (e) => this.handleSubmit(e));
    // 고치기 시작하면 그 필드의 안내 문구를 지운다
    form.addEventListener('input', (e) => {
      this.clearError(e.target);
      if (e.target.id === 'f-start') this.clearError($('#f-due'));
    });
    $('#form-cancel').addEventListener('click', () => {
      if (this.editingId) this.openDetail(this.editingId);
      else this.closeModal();
    });
  },

  // ev가 있으면 수정, 없으면 추가 (startDate를 미리 채울 수 있음)
  openForm({ id = null, startDate = '' } = {}) {
    if (!this.canEdit()) return;
    const ev = id ? store.find(id) : null;
    this.editingId = ev ? ev.id : null;
    this.detailId = null;

    const form = $('#event-form');
    form.reset();
    for (const input of form.querySelectorAll('input, select, textarea')) this.clearError(input);

    $('#f-title').value = ev ? ev.title : '';
    $('#f-category').value = ev ? ev.category : 'notice';
    $('#f-subject').value = ev ? ev.subject : '';
    $('#f-start').value = ev ? ev.startDate : startDate;
    $('#f-due').value = ev ? utils.dueOf(ev) : '';
    $('#f-time').value = ev ? ev.dueTime : '';
    $('#f-desc').value = ev ? ev.description : '';
    this.updateSubjectField();
    this.updateDescCount();

    this.showPane('form');
    this.openModal(ev ? '일정 수정' : '일정 추가');
    $('#f-title').focus();
  },

  updateSubjectField() {
    $('#subject-field').hidden = !SUBJECT_CATEGORIES.has($('#f-category').value);
  },

  updateDescCount() {
    $('#desc-count').textContent = `${$('#f-desc').value.length} / ${LIMITS.description}`;
  },

  readForm() {
    const category = $('#f-category').value;
    const startDate = $('#f-start').value;
    return {
      title: $('#f-title').value.trim().slice(0, LIMITS.title),
      category,
      subject: SUBJECT_CATEGORIES.has(category) ? $('#f-subject').value.trim().slice(0, LIMITS.subject) : '',
      startDate,
      dueDate: $('#f-due').value || startDate, // 비면 시작일과 같게
      dueTime: $('#f-time').value,
      description: $('#f-desc').value.trim().slice(0, LIMITS.description),
    };
  },

  async handleSubmit(e) {
    e.preventDefault();
    if (!this.canEdit() || this.saving) return;
    const values = this.readForm();
    const errors = utils.validateEvent(values);
    const fields = { title: '#f-title', category: '#f-category', startDate: '#f-start', dueDate: '#f-due' };
    let firstInvalid = null;
    for (const [name, selector] of Object.entries(fields)) {
      const input = $(selector);
      if (errors[name]) {
        this.showError(input, errors[name]);
        firstInvalid = firstInvalid || input;
      } else {
        this.clearError(input);
      }
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const now = Date.now();
    const existing = this.editingId ? store.find(this.editingId) : null;
    const event = existing
      ? { ...existing, ...values, updatedAt: now }
      : { id: utils.uuid(), ...values, status: 'auto', createdAt: now, updatedAt: now };
    // 실패하면 폼에 쓴 내용은 그대로 두고 원인만 알린다
    const ok = await this.runWrite($('#form-submit'), () => store.commitSave(event, !existing));
    if (!ok) return;
    render.all();

    // 수정은 상세로 돌아가 "마지막 수정"을 보여주고, 추가는 닫는다
    if (existing) this.openDetail(event.id);
    else this.closeModal();
    this.toast('저장했어요.');
  },

  // 안내 문구는 input의 aria-describedby 중 field-error 요소에 넣는다
  errorElementFor(input) {
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/);
    return ids.map((id) => document.getElementById(id)).find((el) => el && el.classList.contains('field-error')) || null;
  },

  showError(input, message) {
    const errorEl = this.errorElementFor(input);
    input.setAttribute('aria-invalid', 'true');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  },

  clearError(input) {
    const errorEl = this.errorElementFor(input);
    input.removeAttribute('aria-invalid');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
  },

  toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2500);
  },
};

// tests.html처럼 화면이 없는 페이지에서는 utils만 쓰고 앱은 시작하지 않는다
if ($('#month-grid')) {
  render.categoryStyles();
  store.init();
  ui.init();
  render.all(); // 캐시를 먼저 그리고
  ui.sync(); // 뒤에서 서버 목록으로 바꾼다
}
