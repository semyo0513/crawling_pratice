/**
 * ================================================================
 *  대중매체·개인방송 비판적 시청 활동지 — [미디어 팩트체크 탐정본부] 서버(Code.gs)
 * ----------------------------------------------------------------
 *  - 학생: 방탈출 퀘스트 단계별 진행, 스텝 전환 시 자동 임시저장, 유튜브 자동완성
 *  - 교사: 제출 현황 관리, 시청 콘텐츠 통계 분석, 문항 설정, 비밀번호 변경, 채점/피드백
 *  - 통신: google.script.run (GAS) + doPost JSON API (GitHub 배포 완벽 지원)
 * ================================================================
 */

/** ─────────────────────────────────────────
 *  0. 환경 설정
 *  ───────────────────────────────────────── */
const CONFIG = {
  ACTIVITY_TITLE: '미디어 팩트체크 탐정 수사본부',
  SHEET_NAME: '학생응답',
  SETTINGS_PROP_KEY: 'ACTIVITY_CUSTOM_SETTINGS',
  TEACHER_SESSION_TTL: 6 * 60 * 60, // 6시간
  MAX_ROWS: { STEP1: 10, STEP2: 10, STEP3: 15, STEP4: 6 },
  MAX_TEXT_LENGTH: 2000
};

// 시트 헤더 컬럼 정의
const HEADERS = [
  'ID', '활동명', '제출시각', '수정시각',
  '학년', '반', '번호', '이름',
  '채널명', '영상제목', '영상URL',
  'STEP1_JSON', 'STEP2_JSON', 'STEP3_JSON', 'STEP4_JSON',
  '요약텍스트',
  '상태', '점수', '교사피드백', '반려사유', '채점자', '채점시각'
];

/** ─────────────────────────────────────────
 *  1. 웹앱 진입점 (doGet / doPost)
 *  ───────────────────────────────────────── */
function doGet(e) {
  ensureSheet_();
  
  if (e && e.parameter && e.parameter.action) {
    const result = dispatch(e.parameter.action, e.parameter);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const template = HtmlService.createTemplateFromFile('index');
  const settings = getCustomSettings_();
  template.activityTitle = settings.activityTitle || CONFIG.ACTIVITY_TITLE;
  
  return template.evaluate()
    .setTitle(settings.activityTitle || CONFIG.ACTIVITY_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 깃허브 페이지 등 외부 배포용 POST 요청 엔드포인트 */
function doPost(e) {
  try {
    let payload = {};
    let action = '';
    if (e && e.postData && e.postData.contents) {
      const parsed = JSON.parse(e.postData.contents);
      action = parsed.action;
      payload = parsed.payload || {};
    } else if (e && e.parameter) {
      action = e.parameter.action;
      payload = e.parameter.payload ? JSON.parse(e.parameter.payload) : e.parameter;
    }
    const result = dispatch(action, payload);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      message: (err && err.message) ? err.message : '요청 처리 중 오류가 발생했습니다.'
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/** 단일 라우터 */
function dispatch(action, payload) {
  try {
    switch (action) {
      case 'getPublicConfig':        return { ok: true, data: handleGetPublicConfig_() };
      case 'loadResponse':           return { ok: true, data: handleLoadResponse_(payload) };
      case 'saveDraft':              return { ok: true, data: handleSave_(payload, 'DRAFT') };
      case 'submit':                 return { ok: true, data: handleSave_(payload, 'SUBMITTED') };
      case 'teacherLogin':           return { ok: true, data: handleTeacherLogin_(payload) };
      case 'teacherList':            return { ok: true, data: handleTeacherList_(payload) };
      case 'teacherDetail':          return { ok: true, data: handleTeacherDetail_(payload) };
      case 'teacherGrade':           return { ok: true, data: handleTeacherGrade_(payload) };
      case 'teacherReturn':          return { ok: true, data: handleTeacherReturn_(payload) };
      case 'teacherStats':           return { ok: true, data: handleTeacherStats_(payload) };
      case 'teacherChangePassword':  return { ok: true, data: handleChangePassword_(payload) };
      case 'saveSettings':           return { ok: true, data: handleSaveSettings_(payload) };
      case 'loadSettings':           return { ok: true, data: handleLoadSettings_(payload) };
      default:
        throw new Error('알 수 없는 요청입니다: ' + action);
    }
  } catch (err) {
    return { ok: false, message: (err && err.message) ? err.message : '처리 중 오류가 발생했습니다.' };
  }
}

/** ─────────────────────────────────────────
 *  2. 공용 설정 및 학생 기능
 *  ───────────────────────────────────────── */
function handleGetPublicConfig_() {
  return getCustomSettings_();
}

function handleLoadResponse_(payload) {
  if (!payload) throw new Error('조회할 학생 정보가 없습니다.');
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();

  let idx = -1;
  if (payload.id) idx = findRowIndexById_(data, payload.id);
  if (idx === -1 && payload.grade && payload.classNum && payload.number) {
    idx = findRowIndexByKey_(data, payload.grade, payload.classNum, payload.number);
  }
  if (idx === -1) return { found: false };

  const rec = rowToRecord_(data[idx]);
  rec.submittedAt = formatDate_(rec.submittedAt);
  rec.updatedAt = formatDate_(rec.updatedAt);
  return { found: true, record: rec };
}

function handleSave_(payload, intendedStatus) {
  validateStudentPayload_(payload);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();

    let idx = -1;
    if (payload.id) idx = findRowIndexById_(data, payload.id);
    if (idx === -1) idx = findRowIndexByKey_(data, payload.grade, payload.classNum, payload.number);

    const now = new Date();
    let id, submittedAt, prevStatus, prevScore, prevFeedback, prevGrader, prevGradedAt;

    if (idx > -1) {
      const existing = rowToRecord_(data[idx]);
      prevStatus = existing.status;

      if (prevStatus === 'GRADED') {
        throw new Error('이미 채점이 완료된 활동지는 수정할 수 없습니다.');
      }
      if (intendedStatus === 'DRAFT' && prevStatus === 'SUBMITTED') {
        throw new Error('이미 제출된 활동지입니다. 수정을 원하시면 선생님께 반려를 요청하세요.');
      }

      id = existing.id;
      submittedAt = existing.submittedAt;
      prevScore = existing.score;
      prevFeedback = existing.feedback;
      prevGrader = existing.graderEmail;
      prevGradedAt = existing.gradedAt;
    } else {
      id = Utilities.getUuid();
      submittedAt = '';
      prevStatus = '';
      prevScore = ''; prevFeedback = ''; prevGrader = ''; prevGradedAt = '';
    }

    const finalStatus = (intendedStatus === 'SUBMITTED')
      ? 'SUBMITTED'
      : (prevStatus === 'RETURNED' ? 'RETURNED' : 'DRAFT');

    if (intendedStatus === 'SUBMITTED' && !submittedAt) {
      submittedAt = now;
    }

    const currentTitle = (getCustomSettings_().activityTitle) || CONFIG.ACTIVITY_TITLE;

    const record = {
      id: id,
      activityTitle: currentTitle,
      submittedAt: submittedAt,
      updatedAt: now,
      grade: payload.grade,
      classNum: payload.classNum,
      number: payload.number,
      name: String(payload.name).trim(),
      channelName: payload.channelName || '',
      videoTitle: payload.videoTitle || '',
      videoUrl: payload.videoUrl || '',
      step1: payload.step1 || [],
      step2: payload.step2 || [],
      step3: payload.step3 || [],
      step4: payload.step4 || [],
      summary: buildSummaryText_(payload),
      status: finalStatus,
      score: prevScore,
      feedback: prevFeedback,
      returnReason: intendedStatus === 'SUBMITTED' ? '' : (idx > -1 ? (data[idx][HEADERS.indexOf('반려사유')] || '') : ''),
      graderEmail: prevGrader,
      gradedAt: prevGradedAt
    };

    const rowArray = buildRowArray_(record);
    if (idx > -1) {
      sheet.getRange(idx + 1, 1, 1, HEADERS.length).setValues([rowArray]);
    } else {
      sheet.appendRow(rowArray);
    }

    return {
      id: id,
      status: finalStatus,
      updatedAt: formatDate_(now)
    };
  } finally {
    lock.releaseLock();
  }
}

/** ─────────────────────────────────────────
 *  3. 교사 관리자 기능
 *  ───────────────────────────────────────── */
function handleTeacherLogin_(payload) {
  let storedHash = PropertiesService.getScriptProperties().getProperty('TEACHER_PASSWORD_HASH');
  
  if (!storedHash) {
    storedHash = sha256Hex_('1234');
    PropertiesService.getScriptProperties().setProperty('TEACHER_PASSWORD_HASH', storedHash);
  }

  if (!payload || !payload.password) {
    throw new Error('비밀번호를 입력해 주세요.');
  }
  if (sha256Hex_(payload.password) !== storedHash) {
    throw new Error('비밀번호가 일치하지 않습니다.');
  }
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('teacher_' + token, 'valid', CONFIG.TEACHER_SESSION_TTL);
  return { token: token };
}

function handleChangePassword_(payload) {
  verifyTeacherToken_(payload && payload.token);
  if (!payload || !payload.newPassword) {
    throw new Error('새 비밀번호를 입력해 주세요.');
  }
  if (payload.newPassword.length < 4) {
    throw new Error('비밀번호는 최소 4자리 이상이어야 합니다.');
  }
  PropertiesService.getScriptProperties().setProperty('TEACHER_PASSWORD_HASH', sha256Hex_(payload.newPassword));
  return { success: true };
}

function handleTeacherList_(payload) {
  verifyTeacherToken_(payload && payload.token);
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const currentTitle = (getCustomSettings_().activityTitle) || CONFIG.ACTIVITY_TITLE;

  const list = [];
  for (let i = 1; i < data.length; i++) {
    const rec = rowToRecord_(data[i]);
    list.push({
      id: rec.id,
      grade: rec.grade, classNum: rec.classNum, number: rec.number, name: rec.name,
      channelName: rec.channelName, videoTitle: rec.videoTitle, videoUrl: rec.videoUrl,
      status: rec.status, score: rec.score,
      feedback: rec.feedback,
      submittedAt: formatDate_(rec.submittedAt),
      updatedAt: formatDate_(rec.updatedAt)
    });
  }
  list.sort(function (a, b) {
    return (Number(a.grade) - Number(b.grade)) ||
      (Number(a.classNum) - Number(b.classNum)) ||
      (Number(a.number) - Number(b.number));
  });
  return { list: list, activityTitle: currentTitle };
}

function handleTeacherDetail_(payload) {
  verifyTeacherToken_(payload && payload.token);
  if (!payload || !payload.id) throw new Error('학생 정보를 찾을 수 없습니다.');
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const idx = findRowIndexById_(data, payload.id);
  if (idx === -1) throw new Error('해당 학생 응답을 찾을 수 없습니다.');

  const rec = rowToRecord_(data[idx]);
  rec.submittedAt = formatDate_(rec.submittedAt);
  rec.updatedAt = formatDate_(rec.updatedAt);
  rec.gradedAt = formatDate_(rec.gradedAt);
  return rec;
}

function handleTeacherGrade_(payload) {
  verifyTeacherToken_(payload && payload.token);
  if (!payload || !payload.id) throw new Error('학생 정보를 찾을 수 없습니다.');

  let score = payload.score;
  if (score !== '' && score !== null && score !== undefined) {
    score = Number(score);
    if (isNaN(score) || score < 0 || score > 100) {
      throw new Error('점수는 0~100 사이의 숫자로 입력해 주세요.');
    }
  } else {
    score = '';
  }
  const feedback = String(payload.feedback || '');
  if (feedback.length > CONFIG.MAX_TEXT_LENGTH) throw new Error('피드백 내용이 너무 깁니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    const idx = findRowIndexById_(data, payload.id);
    if (idx === -1) throw new Error('해당 학생 응답을 찾을 수 없습니다.');

    const now = new Date();
    let graderEmail = '';
    try { graderEmail = Session.getActiveUser().getEmail() || ''; } catch (e) { graderEmail = ''; }

    sheet.getRange(idx + 1, HEADERS.indexOf('상태') + 1).setValue('GRADED');
    sheet.getRange(idx + 1, HEADERS.indexOf('점수') + 1).setValue(score);
    sheet.getRange(idx + 1, HEADERS.indexOf('교사피드백') + 1).setValue(feedback);
    sheet.getRange(idx + 1, HEADERS.indexOf('채점자') + 1).setValue(graderEmail);
    sheet.getRange(idx + 1, HEADERS.indexOf('채점시각') + 1).setValue(now);

    return { status: 'GRADED', gradedAt: formatDate_(now) };
  } finally {
    lock.releaseLock();
  }
}

function handleTeacherReturn_(payload) {
  verifyTeacherToken_(payload && payload.token);
  if (!payload || !payload.id) throw new Error('학생 정보를 찾을 수 없습니다.');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('반려 사유를 입력해 주세요.');
  if (reason.length > CONFIG.MAX_TEXT_LENGTH) throw new Error('반려 사유가 너무 깁니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    const idx = findRowIndexById_(data, payload.id);
    if (idx === -1) throw new Error('해당 학생 응답을 찾을 수 없습니다.');

    const now = new Date();
    sheet.getRange(idx + 1, HEADERS.indexOf('상태') + 1).setValue('RETURNED');
    sheet.getRange(idx + 1, HEADERS.indexOf('반려사유') + 1).setValue(reason);
    sheet.getRange(idx + 1, HEADERS.indexOf('수정시각') + 1).setValue(now);

    return { status: 'RETURNED' };
  } finally {
    lock.releaseLock();
  }
}

/** ─────────────────────────────────────────
 *  4. 시청 콘텐츠 통계 및 설정 관리
 *  ───────────────────────────────────────── */
function handleTeacherStats_(payload) {
  verifyTeacherToken_(payload && payload.token);
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();

  let totalCount = 0;
  const statusCounts = { DRAFT: 0, SUBMITTED: 0, RETURNED: 0, GRADED: 0 };
  const channelMap = {};
  const videoMap = {};
  const categoryCounts = {};
  let totalScore = 0;
  let gradedCount = 0;

  for (let i = 1; i < data.length; i++) {
    totalCount++;
    const rec = rowToRecord_(data[i]);
    if (statusCounts[rec.status] !== undefined) {
      statusCounts[rec.status]++;
    }

    if (rec.channelName) {
      const ch = rec.channelName.trim();
      channelMap[ch] = (channelMap[ch] || 0) + 1;
    }
    if (rec.videoTitle) {
      const vt = rec.videoTitle.trim();
      videoMap[vt] = (videoMap[vt] || 0) + 1;
    }

    if (rec.status === 'GRADED' && rec.score !== '' && rec.score !== null && !isNaN(Number(rec.score))) {
      totalScore += Number(rec.score);
      gradedCount++;
    }

    if (Array.isArray(rec.step2)) {
      rec.step2.forEach(function (s) {
        if (s && s.category) {
          categoryCounts[s.category] = (categoryCounts[s.category] || 0) + 1;
        }
      });
    }
  }

  const topChannels = Object.keys(channelMap).map(function (k) {
    return { name: k, count: channelMap[k] };
  }).sort(function (a, b) { return b.count - a.count; }).slice(0, 10);

  const topVideos = Object.keys(videoMap).map(function (k) {
    return { title: k, count: videoMap[k] };
  }).sort(function (a, b) { return b.count - a.count; }).slice(0, 10);

  const avgScore = gradedCount > 0 ? (totalScore / gradedCount).toFixed(1) : 0;

  return {
    totalStudents: totalCount,
    statusCounts: statusCounts,
    topChannels: topChannels,
    topVideos: topVideos,
    categoryCounts: categoryCounts,
    avgScore: avgScore,
    gradedCount: gradedCount
  };
}

function handleLoadSettings_(payload) {
  verifyTeacherToken_(payload && payload.token);
  return getCustomSettings_();
}

function handleSaveSettings_(payload) {
  verifyTeacherToken_(payload && payload.token);
  if (!payload || !payload.settings) throw new Error('설정 데이터가 없습니다.');
  
  const current = getCustomSettings_();
  const updated = Object.assign({}, current, payload.settings);
  PropertiesService.getScriptProperties().setProperty(CONFIG.SETTINGS_PROP_KEY, JSON.stringify(updated));
  
  if (payload.newPassword) {
    PropertiesService.getScriptProperties().setProperty('TEACHER_PASSWORD_HASH', sha256Hex_(payload.newPassword));
  }
  return { ok: true };
}

function getCustomSettings_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.SETTINGS_PROP_KEY);
  if (!raw) {
    return {
      activityTitle: CONFIG.ACTIVITY_TITLE,
      stepGuides: {
        step1: '🔍 [단서 수집 1단계] 영상을 보기 전 썸네일과 제목을 스캔하고 호기심 질문을 던져보세요.',
        step2: '💡 [단서 수집 2단계] 영상을 시청하며 이해되지 않거나 수상쩍은 부분을 질문 파일로 분류하세요.',
        step3: '🕵️ [용의자 심리 수사] 댓글 작성자의 숨겨진 의도와 편향된 관점을 추론해보세요.',
        step4: '⚖️ [최종 팩트체크 결론] 미디어가 은폐하거나 다루지 않은 실질적 한계를 비판적으로 파헤치세요.'
      },
      step2Categories: ['이해가 안 되는 부분', '궁금한 점(의문)', '다른 사람 의견이 궁금한 점', '비판적 의문', '기타']
    };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { activityTitle: CONFIG.ACTIVITY_TITLE };
  }
}

/** ─────────────────────────────────────────
 *  5. 유틸리티 함수 및 시트 관리
 *  ───────────────────────────────────────── */
function verifyTeacherToken_(token) {
  if (!token) throw new Error('교사 인증이 필요합니다.');
  const valid = CacheService.getScriptCache().get('teacher_' + token);
  if (valid !== 'valid') throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
}

function ensureSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold').setBackground('#0F172A').setFontColor('#38BDF8');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, HEADERS.length, 130);
    sheet.setColumnWidth(HEADERS.indexOf('요약텍스트') + 1, 380);
  }
  return sheet;
}

function getSheet_() {
  return ensureSheet_();
}

function findRowIndexById_(data, id) {
  const col = HEADERS.indexOf('ID');
  for (let i = 1; i < data.length; i++) {
    if (data[i][col] === id) return i;
  }
  return -1;
}

function findRowIndexByKey_(data, grade, classNum, number) {
  const gCol = HEADERS.indexOf('학년');
  const cCol = HEADERS.indexOf('반');
  const nCol = HEADERS.indexOf('번호');
  for (let i = 1; i < data.length; i++) {
    if (Number(data[i][gCol]) === Number(grade) &&
        Number(data[i][cCol]) === Number(classNum) &&
        Number(data[i][nCol]) === Number(number)) {
      return i;
    }
  }
  return -1;
}

function rowToRecord_(rowValues) {
  function get(name) { 
    const idx = HEADERS.indexOf(name);
    return idx > -1 && idx < rowValues.length ? rowValues[idx] : ''; 
  }
  function safeParse(v) {
    try { return v ? JSON.parse(v) : []; } catch (e) { return []; }
  }
  return {
    id: get('ID'),
    activityTitle: get('활동명'),
    submittedAt: get('제출시각'),
    updatedAt: get('수정시각'),
    grade: get('학년'), classNum: get('반'), number: get('번호'), name: get('이름'),
    channelName: get('채널명'), videoTitle: get('영상제목'), videoUrl: get('영상URL'),
    step1: safeParse(get('STEP1_JSON')),
    step2: safeParse(get('STEP2_JSON')),
    step3: safeParse(get('STEP3_JSON')),
    step4: safeParse(get('STEP4_JSON')),
    status: get('상태'), score: get('점수'), feedback: get('교사피드백'),
    returnReason: get('반려사유'), graderEmail: get('채점자'), gradedAt: get('채점시각')
  };
}

function buildRowArray_(r) {
  return [
    r.id, r.activityTitle || CONFIG.ACTIVITY_TITLE, r.submittedAt || '', r.updatedAt || '',
    r.grade, r.classNum, r.number, r.name, r.channelName, r.videoTitle, r.videoUrl || '',
    JSON.stringify(r.step1 || []), JSON.stringify(r.step2 || []),
    JSON.stringify(r.step3 || []), JSON.stringify(r.step4 || []),
    r.summary || '', r.status,
    (r.score === undefined || r.score === null) ? '' : r.score,
    r.feedback || '', r.returnReason || '', r.graderEmail || '', r.gradedAt || ''
  ];
}

function buildSummaryText_(p) {
  const lines = [];
  lines.push('■ STAGE 1. 훑어보기 호기심 질문');
  (p.step1 || []).forEach(function (r, i) {
    lines.push((i + 1) + '. Q: ' + (r.question || '') + ' / A: ' + (r.answer || ''));
  });
  lines.push('');
  lines.push('■ STAGE 2. 나만의 질문 파일링');
  (p.step2 || []).forEach(function (r, i) {
    lines.push((i + 1) + '. [' + (r.category || '미분류') + '] ' + (r.question || ''));
  });
  lines.push('');
  lines.push('■ STAGE 3. 댓글 심리 수사');
  (p.step3 || []).forEach(function (r, i) {
    lines.push((i + 1) + '. 댓글: ' + (r.comment || '') + ' → 의도/관점: ' + (r.intent || ''));
  });
  lines.push('');
  lines.push('■ STAGE 4. 팩트체커 최종 비판 질문');
  (p.step4 || []).forEach(function (r, i) {
    lines.push((i + 1) + '. 인용: ' + (r.quote || ''));
    lines.push('   - 작성자 배경 추론: ' + (r.background || ''));
    lines.push('   - 미디어 한계 파악: ' + (r.limitation || ''));
  });
  return lines.join('\n');
}

function validateStudentPayload_(payload) {
  if (!payload) throw new Error('전달된 데이터가 없습니다.');
  const grade = Number(payload.grade);
  const classNum = Number(payload.classNum);
  const number = Number(payload.number);
  if (!grade || grade < 1 || grade > 6) throw new Error('학년을 올바르게 입력해 주세요 (1~6).');
  if (!classNum || classNum < 1 || classNum > 20) throw new Error('반을 올바르게 입력해 주세요 (1~20).');
  if (!number || number < 1 || number > 45) throw new Error('번호를 올바르게 입력해 주세요 (1~45).');
  if (!payload.name || !String(payload.name).trim()) throw new Error('이름을 입력해 주세요.');
  if (String(payload.name).length > 20) throw new Error('이름이 너무 깁니다.');

  validateStepArray_(payload.step1, CONFIG.MAX_ROWS.STEP1, ['question', 'answer'], 'STEP1');
  validateStepArray_(payload.step2, CONFIG.MAX_ROWS.STEP2, ['question', 'category'], 'STEP2');
  validateStepArray_(payload.step3, CONFIG.MAX_ROWS.STEP3, ['comment', 'intent'], 'STEP3');
  validateStepArray_(payload.step4, CONFIG.MAX_ROWS.STEP4, ['quote', 'background', 'limitation'], 'STEP4');
}

function validateStepArray_(arr, maxRows, fields, label) {
  if (!arr) return;
  if (!Array.isArray(arr)) throw new Error(label + ' 데이터 형식이 올바르지 않습니다.');
  if (arr.length > maxRows) throw new Error(label + ' 항목이 너무 많습니다. (최대 ' + maxRows + '개)');
  arr.forEach(function (item) {
    fields.forEach(function (f) {
      const v = item ? item[f] : '';
      if (v && String(v).length > CONFIG.MAX_TEXT_LENGTH) {
        throw new Error(label + ' 항목 내용이 너무 깁니다.');
      }
    });
  });
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); })
    .join('');
}

function formatDate_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  }
  return String(v);
}