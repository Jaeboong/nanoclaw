/**
 * Neutral Korean message catalog (public).
 *
 * All user-facing strings live here. Personal/character-specific tones
 * override individual keys via `src/tone/<tone>.ts` (gitignored, optional)
 * and are selected at startup with NANOCLAW_TONE.
 *
 * Placeholders use `{name}` syntax and are substituted via the second
 * argument of `getMessage`.
 */

export type MessageKey =
  | 'jira.sync.ok'
  | 'jira.sync.fail'
  | 'jira.subtask.error'
  | 'jira.subtask.empty'
  | 'workSync.ok'
  | 'nonjira.edit.empty'
  | 'nonjira.edit.pick'
  | 'nonjira.edit.gone'
  | 'nonjira.edit.ok'
  | 'nonjira.delete.empty'
  | 'nonjira.delete.pick'
  | 'nonjira.delete.summary'
  | 'nonjira.add.ok'
  | 'nonjira.add.autoNote'
  | 'nonjira.promote.empty'
  | 'nonjira.promote.pick'
  | 'nonjira.promote.header'
  | 'nonjira.promote.emptyResult'
  | 'nonjira.item.gone'
  | 'suggestion.gone'
  | 'suggestion.goneShort'
  | 'suggestion.notTransition'
  | 'suggestion.missingKey'
  | 'suggestion.apply.fail'
  | 'suggestion.apply.ok'
  | 'suggestion.delete.alreadyGone'
  | 'suggestion.delete.ok'
  | 'suggestion.edit.gone'
  | 'suggestion.edit.ok'
  | 'notes.empty.all'
  | 'notes.empty.filtered'
  | 'notes.list.truncated24'
  | 'notes.list.truncated25'
  | 'notes.list.empty'
  | 'notes.notFound'
  | 'notes.idNotFound'
  | 'notes.unknownChoice'
  | 'notes.unknownButton'
  | 'notes.unknownModal'
  | 'notes.idParseFail'
  | 'notes.archive.empty'
  | 'notes.complete.ok'
  | 'notes.delete.ok'
  | 'notes.add.ok'
  | 'notes.add.contentRequired'
  | 'notes.edit.ok'
  | 'notes.opinion.ok'
  | 'notes.opinion.contentRequired'
  | 'notes.opinion.linkParseFail'
  | 'notes.opinion.linkNotFound'
  | 'notes.search.empty'
  | 'notes.search.queryRequired'
  | 'notes.error.generic';

export const NEUTRAL_MESSAGES: Record<MessageKey, string> = {
  'jira.sync.ok': '동기화 완료',
  'jira.sync.fail': '동기화 실패 — 로그 확인 필요',
  'jira.subtask.error': '서브태스크 표시 실패 — 로그 확인',
  'jira.subtask.empty': '현재 열린 서브태스크가 없습니다.',
  'workSync.ok': '작업 렛저 (Jira / Non-Jira / 권장) 동기화 완료',
  'nonjira.edit.empty': '수정할 항목이 없습니다.',
  'nonjira.edit.pick': '수정할 항목을 하나 선택해 주세요.',
  'nonjira.edit.gone': '항목이 사라졌습니다.',
  'nonjira.edit.ok': '수정 완료 — `{side}` "{text}"',
  'nonjira.delete.empty': '삭제할 항목이 없습니다.',
  'nonjira.delete.pick':
    '삭제할 항목을 선택해 주세요 — 여러 개 선택 가능, 전체 삭제는 {total}개 모두 체크. (선택 즉시 삭제)',
  'nonjira.delete.summary': '삭제 완료 — {summary}',
  'nonjira.add.ok': '추가 완료 — `{side}` "{text}"{rest}',
  'nonjira.add.autoNote': '(자동 분류)',
  'nonjira.promote.empty': 'Jira 로 옮길 항목이 없습니다.',
  'nonjira.promote.pick':
    'Jira 에 등재할 항목을 선택해 주세요 — 여러 개 선택 가능, 전체 이동은 {total}개 모두 체크. `[FE]/[BE] 내용` Task 로 생성되고 Non-Jira 에서 빠집니다.',
  'nonjira.promote.header': 'Jira 생성 {n}건 완료:',
  'nonjira.promote.emptyResult': 'Jira 호출 결과가 비어 있습니다.',
  'nonjira.item.gone': '항목이 사라졌습니다 (이미 삭제됨).',
  'suggestion.gone': '추천이 사라졌습니다 (이미 처리되었거나 삭제됨).',
  'suggestion.goneShort': '추천이 사라졌습니다.',
  'suggestion.notTransition':
    '이 추천은 transition 타입이 아닙니다. 수정으로 풀어주세요.',
  'suggestion.missingKey':
    '매칭된 Jira 키가 없습니다. 수정 버튼으로 키를 입력한 뒤 적용해 주세요.',
  'suggestion.apply.fail': '적용 실패 — `{error}`',
  'suggestion.apply.ok': '적용 완료 — `{key}` → **{status}**',
  'suggestion.delete.alreadyGone': '이미 사라진 추천입니다.',
  'suggestion.delete.ok': '추천 삭제 완료.',
  'suggestion.edit.gone': '추천이 사라졌습니다.',
  'suggestion.edit.ok':
    '추천 수정 완료 — `{key}` → **{status}**. 적용 버튼을 누르면 반영됩니다.',
  'notes.empty.all':
    '아직 등록된 항목이 없습니다 {emoji}\n아래 **➕ 추가** 버튼으로 등록해 주세요.',
  'notes.empty.filtered':
    '`{filter}` 카테고리에 항목이 없습니다. 다른 카테고리를 선택해 주세요.',
  'notes.list.truncated24': '({n}건 중 상위 24건만 표시)',
  'notes.list.truncated25': '(총 {n}건 중 상위 25건만 표시)',
  'notes.list.empty': '등록된 항목이 없습니다',
  'notes.notFound': '항목을 찾을 수 없습니다',
  'notes.idNotFound': '#{id} 찾을 수 없음',
  'notes.unknownChoice': '알 수 없는 선택',
  'notes.unknownButton': '알 수 없는 버튼',
  'notes.unknownModal': '알 수 없는 모달',
  'notes.idParseFail': 'ID 파싱 실패',
  'notes.archive.empty': '_보관함이 비어 있습니다._',
  'notes.complete.ok': '{emoji} **#{padded}** 완료 처리, 보관함으로 이동',
  'notes.delete.ok': '{emoji} **#{padded}** 삭제 완료',
  'notes.add.ok': '{emoji} **#{padded}** 추가 완료',
  'notes.add.contentRequired': '내용은 필수입니다',
  'notes.edit.ok': '{emoji} **#{padded}** 수정 완료',
  'notes.opinion.ok': '{emoji} **{name}**의 의견 #{padded}{linked} 기록 완료',
  'notes.opinion.contentRequired': '의견 내용은 필수입니다',
  'notes.opinion.linkParseFail': '연결 ID 파싱 실패',
  'notes.opinion.linkNotFound': '#{padded} 항목을 찾을 수 없습니다',
  'notes.search.empty': '`{kw}` 매칭 항목이 없습니다.',
  'notes.search.queryRequired': '검색어를 입력해 주세요',
  'notes.error.generic': '처리 중 오류 발생',
};

export const NEUTRAL_EMOJI = '';
