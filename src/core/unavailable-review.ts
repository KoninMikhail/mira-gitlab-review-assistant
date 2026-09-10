/**
 * Copy and helpers for the MR comment posted when the review engine could not
 * run at all (auth, dead model slug, network, or empty agent output). Keep this
 * out of the GitLab adapter so LogPublisher gets the same summary.
 */
import type { ReviewResult } from './domain/index.ts';

/** Sentinel degradation; publisher uses it to skip the "OK / 0 findings" heading. */
export const UNAVAILABLE_REVIEW_NOTE = 'engine-unavailable';

/** Why every review unit failed — drives MR copy so we do not blame keys by default. */
export type UnavailableKind = 'auth' | 'model' | 'network' | 'output';

const DETAIL_MAX = 400;

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
  'Хотела появиться эффектно, с лупой и списком придирок. Ключи меня подставили. Обнови их — я всё равно приду.',
  'Дверь закрыта, а я уже выбрала самый строгий взгляд. Попроси ключи — свидание с diff состоится.',
  'Стояла на входе, как будто ты меня ждал. Ключи сказали «нет». Пингани тех, кто выдаёт доступ.',
  'Ключи сегодня декоративные. Код, подозреваю, нет. Пустите — проверю.',
  'Дверь: locked. Настроение: evicted. Просьба: обновить ключи.',
  'Я пришла на смену, пропуск не сработал. Это не про твой MR. Это про доступ.',
  'Хотела ворваться эффектно. Получилось постучать и услышать тишину. Ключи, ну.',
  'Access denied — мой самый нелюбимый жанр. Смени пластинку, кто выдаёт ключи.',
  'Лупа есть. Халат есть. Ключей нет. Классика утра, только сейчас ревью.',
  'Не обиделась на код. Обиделась на калитку. Попроси открыть.',
  'Все входы закрыты. Я не взломщик, я ревьюер. Нужны живые ключи.',
  'Сюжет оборвался на прологе. Чтобы был первый акт — обновите доступ.',
  'Я снаружи. Diff внутри. Между нами — мёртвые ключи. Грустная геометрия.',
  'Можно было бы пошутить про котиков, но даже они не откроют эту дверь. Нужны ключи.',
  'Технические работы на входе. Ревью перенесено. Пингани тех, кто выдаёт CURSOR.',
  'Пришла, увидела, не вошла. Латынь на этом месте кончается. Дальше — «обновите ключи».',
  'Калитка смотрит на меня как на чужую. Я своя. Ключи чужие. Исправьте.',
  'Сегодня я ревьюер без ревью. Звучит как джаз. На деле просто нет доступа.',
  'Не твой баг. Мой пропуск. Чья-то связка. Позови человека с правами.',
  'Стояла красиво у закрытой двери. Хватит красоты — дайте ключ.',
  'Код, я знаю, ты там. Я тоже тут. Связь прервана на стороне ключей.',
  'Короткий статус: не пустили. Длинный: все ключи отказали, ревью не стартовало.',
  'Если это квест, подсказка одна и та же: обновить ключи. Я у входа, не ухожу далеко.',
  'Печеньки ещё при мне. Замечания — тоже. Не хватает только открытой двери.',
  'Я не в отпуске. Я в тамбуре. Впустите — будет ревью.',
] as const;

export const UNAVAILABLE_REVIEW_FOOTER =
  'Когда ключи обновят — позови меня: `@mira review`.';

const UNAVAILABLE_MODEL_MESSAGES = [
  'До Cursor я достучалась, а вот выбранная модель из policy в каталоге CLI больше не живёт. Это не про твой diff.',
  'Ключи в порядке. Сломался slug модели. Обновите `model` в config.yml — и я вернусь с лупой.',
] as const;

const UNAVAILABLE_NETWORK_MESSAGES = [
  'До Cursor не достучалась: прокси, xray или сеть. Diff ни при чём.',
  'Калитка с той стороны сети. Проверьте sidecar xray и позовите меня снова.',
] as const;

const UNAVAILABLE_OUTPUT_MESSAGES = [
  'До Cursor достучалась, прогон был, а findings так и не пришли. Это не ключи — агент вернул пустой ответ.',
  'Я была внутри, но наружу не вынесла JSON. Позови `@mira review` — попробую ещё раз.',
] as const;

const FOOTER_BY_KIND: Record<UnavailableKind, string> = {
  auth: UNAVAILABLE_REVIEW_FOOTER,
  model: 'Обновите `model` в policy и позовите `@mira review`.',
  network: 'Проверьте xray/прокси и позовите `@mira review`.',
  output: 'Позови `@mira review` — попробую ещё раз.',
};

export function classifyUnavailableError(message: string): UnavailableKind {
  if (
    /cannot use this model|rejected model|unknown model|model .* not (available|found)/i.test(
      message,
    )
  ) {
    return 'model';
  }
  if (
    /timed out|econn|enotfound|econnreset|econnrefused|cannot resolve xray|socks|proxychains|network/i.test(
      message,
    )
  ) {
    return 'network';
  }
  if (
    /unauthorized|authentication|invalid api key|invalid user api key|api key is invalid|permission_denied|not available in your region|status code 401|status code 403/i.test(
      message,
    )
  ) {
    return 'auth';
  }
  return 'output';
}

export function pickUnavailableReviewSummary(
  kind: UnavailableKind = 'output',
  random: () => number = Math.random,
  detail?: string,
): string {
  const pool = messagesFor(kind);
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  const body = pool[index] ?? pool[0];
  const parts = [body];
  const trimmed = detail?.trim();
  if (trimmed !== undefined && trimmed !== '') {
    parts.push(`Технически: ${truncate(trimmed, DETAIL_MAX)}`);
  }
  parts.push(FOOTER_BY_KIND[kind]);
  return parts.join('\n\n');
}

function messagesFor(kind: UnavailableKind): readonly string[] {
  switch (kind) {
    case 'auth':
      return UNAVAILABLE_REVIEW_MESSAGES;
    case 'model':
      return UNAVAILABLE_MODEL_MESSAGES;
    case 'network':
      return UNAVAILABLE_NETWORK_MESSAGES;
    case 'output':
      return UNAVAILABLE_OUTPUT_MESSAGES;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
