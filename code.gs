/**
 * ================================================================
 *  대중매체·개인방송 비판적 시청 활동지 — [미디어 팩트체크 탐정본부] 서버(Code.gs)
 * ----------------------------------------------------------------
 *  - 학생: 학생 개별 비밀번호 직접 설정 및 검증, 방탈출 퀘스트, 스텝 전환 시 자동저장
 *  - 결과조회: 학년/반/번호 + 학생 비밀번호 입력 후 독립 페이지에서 채점 결과/인증서 열람
 *  - 아카이빙: 인스타그램 스타일 수사 피드, 영상 감상, 좋아요(❤️) 및 동료 피드백 댓글(💬)
 *  - 교사: 제출 현황 관리, 시청 콘텐츠 통계, 문항 설정, 비밀번호 변경, 채점/피드백
 *  - 비밀번호/설정: 구글 시트의 [관리자설정] 및 [학생응답] 시트에 직접 저장/관리
 * ================================================================
 */

/** ─────────────────────────────────────────
 *  0. 환경 설정
 *  ───────────────────────────────────────── */
const CONFIG = {
  ACTIVITY_TITLE: '미디어 팩트체크 탐정 수사본부',
  STUDENT_SHEET_NAME: '학생응답',
  SETTINGS_SHEET_NAME: '관리자설정',
  DEFAULT_PASSWORD: '1234',
  TEACHER_SESSION_TTL: 6 * 60 * 60, // 6시간
  MAX_ROWS: { STEP1: 10, STEP2: 10, STEP3: 15, STEP4: 6 },
  MAX_TEXT_LENGTH: 2000
};

// 학생응답 시트 헤더 (비밀번호, 좋아요수, 댓글_JSON 컬럼 포함)
const HEADERS = [
  'ID', '활동명', '제출시각', '수정시각',
  '학년', '반', '번호', '이름', '비밀번호',
  '채널명', '영상제목', '영상URL',
  'STEP1_JSON', 'STEP2_JSON', 'STEP3_JSON', 'STEP4_JSON',
  '요약텍스트',
  '상태', '점수', '교사피드백', '반려사유', '채점자', '채점시각',
  '좋아요수', '댓글_JSON'
];

/** ─────────────────────────────────────────
 *  1. 웹앱 진입점 (doGet / doPost)
 *  ───────────────────────────────────────── */
function doGet(e) {
  ensureAllSheets_();
  
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

/** 깃허브 배포본 fetch용 엔드포인트 */
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

/** 라우터 */
function dispatch(action, payload) {
  try {
    switch (action) {
      case 'getPublicConfig':        return { ok: true, data: handleGetPublicConfig_() };
      case 'loadResponse':           return { ok: true, data: handleLoadResponse_(payload) };
      case 'loadStudentReport':      return { ok: true, data: handleLoadStudentReport_(payload) };
      case 'saveDraft':              return { ok: true, data: handleSave_(payload, 'DRAFT') };
      case 'submit':                 return { ok: true, data: handleSave_(payload, 'SUBMITTED') };
      case 'getArchiveFeed':         return { ok: true, data: handleGetArchiveFeed_(payload) };
      case 'getTextMiningData':      return { ok: true, data: handleTextMining_(payload) };
      case 'toggleLike':             return { ok: true, data: handleToggleLike_(payload) };
      case 'addComment':             return { ok: true, data: handleAddComment_(payload) };
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
 *  2. 공용 설정 및 학생 기능 (학생 비밀번호 체계)
 *  ───────────────────────────────────────── */
function handleGetPublicConfig_() {
  return getCustomSettings_();
}

/** 학생 활동지 조회 (작성 중 복원용) */
function handleLoadResponse_(payload) {
  if (!payload) throw new Error('조회할 학생 정보가 없습니다.');
  const sheet = getStudentSheet_();
  const data = sheet.getDataRange().getValues();

  let idx = -1;
  if (payload.id) idx = findRowIndexById_(data, payload.id);
  if (idx === -1 && payload.grade && payload.classNum && payload.number) {
    idx = findRowIndexByKey_(data, payload.grade, payload.classNum, payload.number);
  }
  if (idx === -1) return { found: false };

  const rec = rowToRecord_(data[idx]);

  // 비밀번호가 설정되어 있는 경우 검증
  if (rec.password && payload.password) {
    if (String(rec.password).trim() !== String(payload.password).trim()) {
      throw new Error('요원 비밀번호가 일치하지 않습니다. 올바른 비밀번호를 입력해 주세요.');
    }
  }

  rec.submittedAt = formatDate_(rec.submittedAt);
  rec.updatedAt = formatDate_(rec.updatedAt);
  rec.password = ''; // 클라이언트 전송 시 보안 마스킹
  return { found: true, record: rec };
}

/** 학생 전용 채점 결과 조회 (인적사항 + 비밀번호 검증) */
function handleLoadStudentReport_(payload) {
  if (!payload || !payload.grade || !payload.classNum || !payload.number) {
    throw new Error('학년, 반, 번호를 입력해 주세요.');
  }
  if (!payload.password) {
    throw new Error('비밀번호를 입력해 주세요.');
  }

  const sheet = getStudentSheet_();
  const data = sheet.getDataRange().getValues();
  const idx = findRowIndexByKey_(data, payload.grade, payload.classNum, payload.number);
  
  if (idx === -1) {
    throw new Error('등록된 수사 일지를 찾을 수 없습니다. 학년, 반, 번호를 확인해 주세요.');
  }

  const rec = rowToRecord_(data[idx]);
  
  // 비밀번호 검증
  if (rec.password && String(rec.password).trim() !== String(payload.password).trim()) {
    throw new Error('비밀번호가 일치하지 않습니다. 활동 시작 시 직접 설정한 비밀번호를 입력해 주세요.');
  }

  rec.submittedAt = formatDate_(rec.submittedAt);
  rec.updatedAt = formatDate_(rec.updatedAt);
  rec.gradedAt = formatDate_(rec.gradedAt);
  rec.password = ''; // 비밀번호 마스킹
  return { found: true, record: rec };
}

/** 활동지 임시저장 / 최종제출 */
function handleSave_(payload, intendedStatus) {
  validateStudentPayload_(payload);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getStudentSheet_();
    const data = sheet.getDataRange().getValues();

    let idx = -1;
    if (payload.id) idx = findRowIndexById_(data, payload.id);
    if (idx === -1) idx = findRowIndexByKey_(data, payload.grade, payload.classNum, payload.number);

    const now = new Date();
    let id, submittedAt, prevStatus, prevScore, prevFeedback, prevGrader, prevGradedAt, studentPw, prevLikes, prevComments;

    if (idx > -1) {
      const existing = rowToRecord_(data[idx]);
      prevStatus = existing.status;
      if (prevStatus === 'GRADED') {
        throw new Error('이미 채점이 완료된 활동지는 수정할 수 없습니다.');
      }
      // 제출 완료(SUBMITTED) 상태라도 채점(GRADED) 전이라면 수정 및 재제출 허용

      // 비밀번호 일치 여부 확인
      if (existing.password && payload.password) {
        if (String(existing.password).trim() !== String(payload.password).trim()) {
          throw new Error('요원 비밀번호가 일치하지 않습니다. 올바른 비밀번호를 입력해 주세요.');
        }
      }

      id = existing.id;
      submittedAt = existing.submittedAt;
      prevScore = existing.score;
      prevFeedback = existing.feedback;
      prevGrader = existing.graderEmail;
      prevGradedAt = existing.gradedAt;
      prevLikes = existing.likes || 0;
      prevComments = existing.comments || [];
      studentPw = payload.password || existing.password || '';
    } else {
      id = Utilities.getUuid();
      submittedAt = '';
      prevStatus = '';
      prevScore = ''; prevFeedback = ''; prevGrader = ''; prevGradedAt = '';
      prevLikes = 0; prevComments = [];
      studentPw = payload.password || '';
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
      password: String(studentPw).trim(),
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
      gradedAt: prevGradedAt,
      likes: prevLikes,
      comments: prevComments
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
 *  3. 📸 수사 갤러리 & 아카이브 피드 (인스타그램 피드 / 피드백 / 좋아요)
 *  ───────────────────────────────────────── */
function handleGetArchiveFeed_(payload) {
  const sheet = getStudentSheet_();
  const data = sheet.getDataRange().getValues();
  const list = [];

  const gradeFilter = payload && payload.grade ? String(payload.grade) : '';
  const classFilter = payload && payload.classNum ? String(payload.classNum) : '';
  const keyword = payload && payload.keyword ? String(payload.keyword).toLowerCase().trim() : '';

  for (let i = 1; i < data.length; i++) {
    const rec = rowToRecord_(data[i]);
    // 제출 완료(SUBMITTED) 또는 채점 완료(GRADED)된 게시물만 아카이빙에 노출
    if (rec.status !== 'SUBMITTED' && rec.status !== 'GRADED') continue;

    if (gradeFilter && String(rec.grade) !== gradeFilter) continue;
    if (classFilter && String(rec.classNum) !== classFilter) continue;
    if (keyword) {
      const match = (rec.name && rec.name.toLowerCase().indexOf(keyword) > -1) ||
                    (rec.videoTitle && rec.videoTitle.toLowerCase().indexOf(keyword) > -1) ||
                    (rec.channelName && rec.channelName.toLowerCase().indexOf(keyword) > -1);
      if (!match) continue;
    }

    list.push({
      id: rec.id,
      grade: rec.grade,
      classNum: rec.classNum,
      number: rec.number,
      name: rec.name,
      channelName: rec.channelName,
      videoTitle: rec.videoTitle,
      videoUrl: rec.videoUrl,
      step1: rec.step1,
      step2: rec.step2,
      step3: rec.step3,
      step4: rec.step4,
      status: rec.status,
      score: rec.score,
      feedback: rec.feedback,
      likes: Number(rec.likes) || 0,
      comments: Array.isArray(rec.comments) ? rec.comments : [],
      submittedAt: formatDate_(rec.submittedAt),
      updatedAt: formatDate_(rec.updatedAt)
    });
  }

  // 정렬 (인기순 / 최신순)
  const sortBy = (payload && payload.sortBy === 'popular') ? 'popular' : 'recent';
  if (sortBy === 'popular') {
    list.sort(function (a, b) {
      return (b.likes - a.likes) || (new Date(b.submittedAt) - new Date(a.submittedAt));
    });
  } else {
    list.sort(function (a, b) {
      return (new Date(b.submittedAt) - new Date(a.submittedAt)) ||
        (Number(a.grade) - Number(b.grade)) ||
        (Number(a.classNum) - Number(b.classNum));
    });
  }

  return { feed: list };
}

/** 좋아요 토글 / 1 증가 */
function handleToggleLike_(payload) {
  if (!payload || !payload.id) throw new Error('게시물 ID가 없습니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getStudentSheet_();
    const data = sheet.getDataRange().getValues();
    const idx = findRowIndexById_(data, payload.id);
    if (idx === -1) throw new Error('해당 게시물을 찾을 수 없습니다.');

    const likeCol = HEADERS.indexOf('좋아요수');
    const currentLikes = Number(data[idx][likeCol]) || 0;
    const nextLikes = currentLikes + 1;

    sheet.getRange(idx + 1, likeCol + 1).setValue(nextLikes);
    return { likes: nextLikes, id: payload.id };
  } finally {
    lock.releaseLock();
  }
}

/** 동료 피드백 댓글 작성 */
function handleAddComment_(payload) {
  if (!payload || !payload.id) throw new Error('게시물 ID가 없습니다.');
  const author = String(payload.authorName || '동료 요원').trim();
  const content = String(payload.content || '').trim();

  if (!content) throw new Error('피드백 댓글 내용을 입력해 주세요.');
  if (content.length > 500) throw new Error('댓글은 최대 500자까지 작성 가능합니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getStudentSheet_();
    const data = sheet.getDataRange().getValues();
    const idx = findRowIndexById_(data, payload.id);
    if (idx === -1) throw new Error('해당 게시물을 찾을 수 없습니다.');

    const commentCol = HEADERS.indexOf('댓글_JSON');
    let comments = [];
    try {
      const raw = data[idx][commentCol];
      if (raw) comments = JSON.parse(raw);
    } catch (e) { comments = []; }

    const newComment = {
      id: Utilities.getUuid().slice(0, 8),
      author: author,
      content: content,
      createdAt: formatDate_(new Date())
    };

    comments.push(newComment);
    sheet.getRange(idx + 1, commentCol + 1).setValue(JSON.stringify(comments));

    return { comments: comments, id: payload.id };
  } finally {
    lock.releaseLock();
  }
}

/** ─────────────────────────────────────────
 *  3-2. 🧠 텍스트 마이닝 및 키워드 분석 엔진
 *  ───────────────────────────────────────── */
function handleTextMining_(payload) {
  const sheet = getStudentSheet_();
  const data = sheet.getDataRange().getValues();

  const gradeFilter = payload && payload.grade ? String(payload.grade) : '';
  const classFilter = payload && payload.classNum ? String(payload.classNum) : '';

  // 1. 한국어 불용어 사전
  const STOPWORDS = {
    '영상': true, '댓글': true, '내용': true, '질문': true, '작성자': true, '생각': true,
    '사람': true, '때문': true, '대한': true, '통해': true, '위해': true, '관련': true,
    '이유': true, '어떤': true, '무엇': true, '어떻게': true, '이런': true, '저런': true,
    '그런': true, '진짜': true, '정말': true, '너무': true, '많이': true, '조금': true,
    '가장': true, '우리': true, '자신': true, '자기': true, '그것': true, '이것': true,
    '저것': true, '부분': true, '하나': true, '모두': true, '모든': true, '다른': true,
    '경우': true, '사실': true, '활동': true, '요원': true, '학생': true, '수사': true,
    '일지': true, '단서': true, '호기심': true, '의문': true, '비판': true, '결론': true,
    '추론': true, '인용': true, '유튜브': true, '채널': true, '제목': true, '이야기': true,
    '그리고': true, '하지만': true, '그러나': true, '따라서': true, '그래서': true, '또한': true
  };

  // 2. 한국어 조사 및 어미 (긴 어미/조사부터 순서대로 매칭)
  const JOSA_EOMI_LIST = [
    '이라는것', '이라는점', '이라고는', '이라면서', '이라던가', '이었을까', '이었는지',
    '에서도', '에서는', '에게는', '한테는', '으로부터', '이지만', '이라서', '이라고', '이라며', '이라는', '보다는',
    '처럼은', '만큼은', '까지는', '부터는', '하다가', '하는데', '하면서', '하였고', '하도록', '하여서', '하니까',
    '하려면', '하였을', '되었을', '됐는지', '스럽다', '스러운', '적인것', '적으로', '적이다', '스러움',
    '에서', '으로', '에게', '한테', '와의', '과의', '에는', '에도', '처럼', '같이', '보다', '대로', '만큼',
    '조차', '마저', '부터', '까지', '마다', '이나', '이란', '이라', '이다', '이며', '이고', '이면', '인데',
    '해서', '했다', '한다', '했던', '하기', '하는', '하면', '할수', '된것', '있는', '있을', '없을', '없는',
    '같다', '같은', '스러', '되고', '되며', '되면', '들의', '들을', '들에', '들이', '이나', '이라', '에는',
    '은', '는', '이', '가', '을', '를', '의', '에', '로', '과', '와', '도', '만', '들'
  ];

  function refineKoreanMorpheme(rawWord) {
    if (!rawWord || typeof rawWord !== 'string') return '';
    let word = rawWord.trim();
    if (word.length < 2) return '';

    // 특수문자 및 숫자 제거
    word = word.replace(/[^가-힣a-zA-Z]/g, '');
    if (word.length < 2 || word.length > 15) return '';

    // 조사/어미 제거 (어간 추출)
    for (let i = 0; i < JOSA_EOMI_LIST.length; i++) {
      const suffix = JOSA_EOMI_LIST[i];
      if (word.length > suffix.length + 1 && word.endsWith(suffix)) {
        const stem = word.slice(0, -suffix.length);
        if (stem.length >= 2) {
          word = stem;
          break; // 가장 긴 접미사 1회 제거
        }
      }
    }

    if (word.length < 2) return '';
    if (STOPWORDS[word]) return '';
    return word;
  }

  const wordCounts = {};
  const stageWords = { step1: {}, step2: {}, step3: {}, step4: {} };
  let totalStudentCount = 0;
  let totalWordCount = 0;
  let totalCluesCount = 0;

  function extractWords(text, stageKey) {
    if (!text || typeof text !== 'string') return;
    const rawTokens = text.replace(/[^가-힣a-zA-Z0-9\s]/g, ' ').split(/\s+/);
    rawTokens.forEach(function (token) {
      const refined = refineKoreanMorpheme(token);
      if (!refined) return;

      totalWordCount++;
      wordCounts[refined] = (wordCounts[refined] || 0) + 1;
      if (stageKey && stageWords[stageKey]) {
        stageWords[stageKey][refined] = (stageWords[stageKey][refined] || 0) + 1;
      }
    });
  }

  for (let i = 1; i < data.length; i++) {
    const rec = rowToRecord_(data[i]);
    if (rec.status !== 'SUBMITTED' && rec.status !== 'GRADED') continue;
    if (gradeFilter && String(rec.grade) !== gradeFilter) continue;
    if (classFilter && String(rec.classNum) !== classFilter) continue;

    totalStudentCount++;

    // STAGE 1
    if (Array.isArray(rec.step1)) {
      rec.step1.forEach(function (row) {
        totalCluesCount++;
        extractWords(row.question, 'step1');
        extractWords(row.answer, 'step1');
      });
    }
    // STAGE 2
    if (Array.isArray(rec.step2)) {
      rec.step2.forEach(function (row) {
        totalCluesCount++;
        extractWords(row.question, 'step2');
        extractWords(row.category, 'step2');
      });
    }
    // STAGE 3
    if (Array.isArray(rec.step3)) {
      rec.step3.forEach(function (row) {
        totalCluesCount++;
        extractWords(row.comment, 'step3');
        extractWords(row.intent, 'step3');
      });
    }
    // STAGE 4
    if (Array.isArray(rec.step4)) {
      rec.step4.forEach(function (row) {
        totalCluesCount++;
        extractWords(row.quote, 'step4');
        extractWords(row.background, 'step4');
        extractWords(row.limitation, 'step4');
      });
    }
  }

  function toSortedList(dict, limit) {
    return Object.keys(dict).map(function (k) {
      return { word: k, count: dict[k] };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, limit || 20);
  }

  const topKeywords = toSortedList(wordCounts, 30);
  const stageTop = {
    step1: toSortedList(stageWords.step1, 10),
    step2: toSortedList(stageWords.step2, 10),
    step3: toSortedList(stageWords.step3, 10),
    step4: toSortedList(stageWords.step4, 10)
  };

  const top3WordList = topKeywords.slice(0, 3).map(function (k) { return '"' + k.word + '"(' + k.count + '회)'; }).join(', ');
  const summaryInsight = totalStudentCount > 0
    ? '총 ' + totalStudentCount + '명의 요원이 작성한 ' + totalCluesCount + '건의 수사 단서에서 ' + totalWordCount + '개의 유의미한 키워드를 추출했습니다. 핵심 관심 키워드는 ' + (top3WordList || '분석 중') + ' 순으로 집중되었습니다.'
    : '분석 대상 활동지가 아직 없습니다.';

  return {
    stats: {
      totalStudents: totalStudentCount,
      totalClues: totalCluesCount,
      totalWords: totalWordCount,
      uniqueWords: Object.keys(wordCounts).length
    },
    topKeywords: topKeywords,
    stageKeywords: stageTop,
    summaryInsight: summaryInsight
  };
}

/** ─────────────────────────────────────────
 *  4. 교사 관리자 기능 (평문 비밀번호 검증)
 *  ───────────────────────────────────────── */
function handleTeacherLogin_(payload) {
  if (!payload || !payload.password) {
    throw new Error('비밀번호를 입력해 주세요.');
  }

  const storedPassword = getTeacherPasswordFromSheet_();
  if (String(payload.password).trim() !== String(storedPassword).trim()) {
    throw new Error('비밀번호가 일치하지 않습니다. (구글 시트 [관리자설정] 시트에서 확인 가능)');
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
  const newPw = String(payload.newPassword).trim();
  if (newPw.length < 4) {
    throw new Error('비밀번호는 최소 4자리 이상이어야 합니다.');
  }

  setTeacherPasswordToSheet_(newPw);
  return { success: true };
}

function handleTeacherList_(payload) {
  verifyTeacherToken_(payload && payload.token);
  const sheet = getStudentSheet_();
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
  const sheet = getStudentSheet_();
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
    const sheet = getStudentSheet_();
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
    const sheet = getStudentSheet_();
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
 *  5. 시청 콘텐츠 통계 및 설정 관리
 *  ───────────────────────────────────────── */
function handleTeacherStats_(payload) {
  verifyTeacherToken_(payload && payload.token);
  const sheet = getStudentSheet_();
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
  saveCustomSettingsToSheet_(updated);
  
  if (payload.newPassword) {
    setTeacherPasswordToSheet_(String(payload.newPassword).trim());
  }
  return { ok: true };
}

/** ─────────────────────────────────────────
 *  6. 구글 시트 기반 [관리자설정] 및 [학생응답] 관리
 *  ───────────────────────────────────────── */
function ensureAllSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 학생응답 시트 확인 및 헤더 보정
  let studentSheet = ss.getSheetByName(CONFIG.STUDENT_SHEET_NAME);
  if (!studentSheet) {
    studentSheet = ss.insertSheet(CONFIG.STUDENT_SHEET_NAME);
    studentSheet.appendRow(HEADERS);
    studentSheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold').setBackground('#0F172A').setFontColor('#38BDF8');
    studentSheet.setFrozenRows(1);
    studentSheet.setColumnWidths(1, HEADERS.length, 130);
    studentSheet.setColumnWidth(HEADERS.indexOf('요약텍스트') + 1, 380);
  } else {
    // 기존 시트에 새로운 컬럼이 없으면 헤더 보정
    const currentHeaders = studentSheet.getRange(1, 1, 1, studentSheet.getLastColumn() || 1).getValues()[0];
    if (currentHeaders.indexOf('좋아요수') === -1 || currentHeaders.indexOf('댓글_JSON') === -1) {
      studentSheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }
  }

  // 2. 관리자설정 시트 확인 및 생성
  let settingsSheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET_NAME);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(CONFIG.SETTINGS_SHEET_NAME);
    const settingsHeaders = ['설정항목', '설정값', '설명'];
    settingsSheet.appendRow(settingsHeaders);
    settingsSheet.getRange(1, 1, 1, 3)
      .setFontWeight('bold').setBackground('#1E293B').setFontColor('#38BDF8');
    settingsSheet.setFrozenRows(1);

    settingsSheet.appendRow(['관리자비밀번호', CONFIG.DEFAULT_PASSWORD, '교사 관리자 화면 로그인 비밀번호 (평문)']);
    settingsSheet.appendRow(['활동지설정_JSON', '', '문항 및 가이드 커스텀 설정 데이터 (JSON)']);

    settingsSheet.setColumnWidth(1, 180);
    settingsSheet.setColumnWidth(2, 350);
    settingsSheet.setColumnWidth(3, 300);
  }

  return { studentSheet: studentSheet, settingsSheet: settingsSheet };
}

function getStudentSheet_() {
  return ensureAllSheets_().studentSheet;
}

function getSettingsSheet_() {
  return ensureAllSheets_().settingsSheet;
}

/** 구글 시트에서 평문 관리자 비밀번호 읽어오기 */
function getTeacherPasswordFromSheet_() {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === '관리자비밀번호') {
      const val = String(data[i][1]).trim();
      return val ? val : CONFIG.DEFAULT_PASSWORD;
    }
  }
  sheet.appendRow(['관리자비밀번호', CONFIG.DEFAULT_PASSWORD, '교사 관리자 화면 로그인 비밀번호 (평문)']);
  return CONFIG.DEFAULT_PASSWORD;
}

/** 구글 시트에 평문 관리자 비밀번호 쓰기 */
function setTeacherPasswordToSheet_(newPw) {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === '관리자비밀번호') {
      sheet.getRange(i + 1, 2).setValue(String(newPw));
      return;
    }
  }
  sheet.appendRow(['관리자비밀번호', String(newPw), '교사 관리자 화면 로그인 비밀번호 (평문)']);
}

/** 구글 시트에서 커스텀 설정 읽어오기 */
function getCustomSettings_() {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === '활동지설정_JSON') {
      const val = data[i][1];
      if (val) {
        try { return JSON.parse(val); } catch (e) { }
      }
    }
  }
  return { activityTitle: CONFIG.ACTIVITY_TITLE };
}

/** 구글 시트에 커스텀 설정 쓰기 */
function saveCustomSettingsToSheet_(settings) {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  const jsonStr = JSON.stringify(settings);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === '활동지설정_JSON') {
      sheet.getRange(i + 1, 2).setValue(jsonStr);
      return;
    }
  }
  sheet.appendRow(['활동지설정_JSON', jsonStr, '문항 및 가이드 커스텀 설정 데이터 (JSON)']);
}

function verifyTeacherToken_(token) {
  if (!token) throw new Error('교사 인증이 필요합니다.');
  const valid = CacheService.getScriptCache().get('teacher_' + token);
  if (valid !== 'valid') throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
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
    password: get('비밀번호'),
    channelName: get('채널명'), videoTitle: get('영상제목'), videoUrl: get('영상URL'),
    step1: safeParse(get('STEP1_JSON')),
    step2: safeParse(get('STEP2_JSON')),
    step3: safeParse(get('STEP3_JSON')),
    step4: safeParse(get('STEP4_JSON')),
    status: get('상태'), score: get('점수'), feedback: get('교사피드백'),
    returnReason: get('반려사유'), graderEmail: get('채점자'), gradedAt: get('채점시각'),
    likes: Number(get('좋아요수')) || 0,
    comments: safeParse(get('댓글_JSON'))
  };
}

function buildRowArray_(r) {
  return [
    r.id, r.activityTitle || CONFIG.ACTIVITY_TITLE, r.submittedAt || '', r.updatedAt || '',
    r.grade, r.classNum, r.number, r.name, r.password || '',
    r.channelName, r.videoTitle, r.videoUrl || '',
    JSON.stringify(r.step1 || []), JSON.stringify(r.step2 || []),
    JSON.stringify(r.step3 || []), JSON.stringify(r.step4 || []),
    r.summary || '', r.status,
    (r.score === undefined || r.score === null) ? '' : r.score,
    r.feedback || '', r.returnReason || '', r.graderEmail || '', r.gradedAt || '',
    r.likes || 0, JSON.stringify(r.comments || [])
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
  
  if (!payload.password || String(payload.password).trim().length < 4) {
    throw new Error('요원 비밀번호를 4자리 이상 설정/입력해 주세요.');
  }

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

function formatDate_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  }
  return String(v);
}