/**
 * Copy and helpers for the MR comment posted when the review engine could not
 * run at all (no working Cursor key / every unit failed). Keep this out of the
 * GitLab adapter so LogPublisher gets the same summary.
 */
import type { ReviewResult } from './domain/index.ts';

/** Sentinel degradation; publisher uses it to skip the "OK / 0 findings" heading. */
export const UNAVAILABLE_REVIEW_NOTE = 'engine-unavailable';

/**
 * Playful Mira lines. One is picked at random per failed run.
 */
export const UNAVAILABLE_REVIEW_MESSAGES = [
  'Псс, я тут. Хотела всё как следует проревьюить, но ключи меня предали. Попроси обновить их — обещаю вернуться с лупой наготове.',
  'Расследование сорвалось на старте: все ключи отказались работать, так что дифф я так и не увидела. Попроси обновить ключи — и я с радостью вернусь копаться в уликах.',
  'Я уже надела халат ревьюера… а ключи сказали «нет». Это не про твой код — просто попроси их обновить.',
  'Код манил, я тянулась, но дверь заперта со всех сторон. Ключи не сработали. Пингани тех, кто их выдаёт, — я рядом.',
  'Кажется, меня сегодня не пустили внутрь: ключи молчат. Дифф ни при чём. Попроси обновить ключи — и я вернусь.',
  'Я пришла с печеньками и списком придирок, а меня даже не впустили. Ключи бастуют. Попроси их обновить — печеньки пока не съела.',
  'Сюжет такой: героиня подходит к диффу, достаёт ключи… и понимает, что это не те. Попроси заменить связку, и второй акт начнётся.',
  'Моя суперсила — находить баги. Сегодня суперсила упёрлась в закрытую калитку. Ключи, ну вы чего. Пингани кого надо — пусть обновят.',
  'Я шепнула коду «покажи, что спрятал», а ключи ответили «не сегодня». Обидно, но поправимо: попроси их обновить.',
  'Ревью отменяется по техническим причинам: я забыла… нет, ключи забыли работать. Попроси свежие — я уже кручусь у входа.',
  'Если б это был квест, я бы сейчас билась головой о locked door. Подсказка одна: обновить ключи. Дальше я сама.',
  'Дифф пахнет приключениями, а у меня на руках бесполезные ключи. Классика. Попроси новые — и я нырну с головой.',
  'Я не обиделась. Ну, почти. Просто все ключи сегодня решили стать декоративными. Попроси, чтобы их оживили.',
  'Представь: я уже открыла блокнот, выбрала самый строгий взгляд… и упёрлась в «access denied». Ключи виноваты, не ты. Попроси обновить.',
  'Коротко: код не видела, замечаний нет, зато есть драма с ключами. Попроси их обновить — драму закроем, ревью откроем.',
] as const;

export const UNAVAILABLE_REVIEW_FOOTER =
  'Когда ключи обновят — позови меня: `@mira review`.';

export function pickUnavailableReviewSummary(random: () => number = Math.random): string {
  const count = UNAVAILABLE_REVIEW_MESSAGES.length;
  const index = Math.min(count - 1, Math.max(0, Math.floor(random() * count)));
  const body = UNAVAILABLE_REVIEW_MESSAGES[index] ?? UNAVAILABLE_REVIEW_MESSAGES[0];
  return `${body}\n\n${UNAVAILABLE_REVIEW_FOOTER}`;
}

export function isUnavailableReview(result: ReviewResult): boolean {
  return result.degradations?.includes(UNAVAILABLE_REVIEW_NOTE) === true;
}

export function unavailableReviewResult(summary: string): ReviewResult {
  return {
    verdict: 'ok',
    summary,
    findings: [],
    degradations: [UNAVAILABLE_REVIEW_NOTE],
  };
}
