import { Side } from './state.js';

const BE_KEYWORDS = [
  'api',
  'db',
  '디비',
  'redis',
  'cache',
  '캐시',
  '서버',
  '백엔드',
  'be',
  'backend',
  'fcm',
  '푸시',
  'jpa',
  'spring',
  '쿼리',
  'sql',
  'varchar',
  'jwt',
  'auth',
  '인증',
  '엔드포인트',
  '컨트롤러',
  '서비스',
  '레포지',
  'webhook',
  '웹훅',
  '경험치',
  '액션',
  '비기능',
  '성능',
];

const FE_KEYWORDS = [
  '화면',
  'ui',
  'ux',
  '레이아웃',
  '버튼',
  '바텀',
  '시트',
  '키보드',
  '스플래쉬',
  '위젯',
  '스낵바',
  '모달',
  '다이얼로그',
  '네비',
  '드래그',
  '드롭',
  '애니메이션',
  '색상',
  '팔레트',
  '아이콘',
  '폰트',
  '캘린더',
  '달력',
  '말풍선',
  '플러터',
  'flutter',
  'fe',
  'frontend',
  '프론트',
  '리워드',
  '캐릭터',
  '상점',
  '도감',
  '튜토리얼',
];

/** Heuristic FE/BE classifier. Defaults to FE when ambiguous (most legacy
 *  followups are UI-side). */
export function classifySide(text: string): Side {
  const lower = text.toLowerCase();
  let beScore = 0;
  let feScore = 0;
  for (const k of BE_KEYWORDS) if (lower.includes(k)) beScore++;
  for (const k of FE_KEYWORDS) if (lower.includes(k)) feScore++;
  if (beScore > feScore) return 'be';
  if (feScore > beScore) return 'fe';
  return 'fe';
}

/** Validate a user-entered side string ("fe", "be", "FE", "프론트", "백") */
export function parseSide(input: string, fallback: Side): Side {
  const v = input.trim().toLowerCase();
  if (v === 'be' || v.includes('백') || v.includes('back')) return 'be';
  if (v === 'fe' || v.includes('프') || v.includes('front')) return 'fe';
  return fallback;
}
