/** Term-frequency saturation of the ranking. */
const RANKING_TERM_SATURATION = 1.2

/** Strength of the text-length normalization of the ranking. */
const RANKING_LENGTH_NORMALIZATION = 0.75

/** Splits text into words in any language, including those without spaces. */
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" })

/** Words of one ranked text, counted for ranking. */
type RankedTextWords = Readonly<{
  /** Number of words in the text. */
  wordCount: number
  /** Occurrences by word. */
  wordCounts: ReadonlyMap<string, number>
}>

/** One query word and how rare it is among the ranked texts. */
type RankedQueryWord = Readonly<{
  /** Query word. */
  word: string
  /** Inverse text frequency of the word; higher for rarer words. */
  inverseFrequency: number
}>

/** What scoring one text needs. */
type TextScoreInput = Readonly<{
  /** Counted words of the text scored. */
  textWords: RankedTextWords
  /** Every distinct query word with its rarity. */
  queryWords: readonly RankedQueryWord[]
  /** Average word count of the ranked texts; positive. */
  averageWordCount: number
}>

/**
 * Lists the words of a text for ranking.
 *
 * @param text - Text to split.
 * @returns Its words, lowercase and compatibility-normalized, in order.
 */
export function listRankingWords(text: string): readonly string[] {
  const normalized = text.normalize("NFKC").toLowerCase()
  return [...WORD_SEGMENTER.segment(normalized)]
    .filter((segment) => segment.isWordLike === true)
    .map((segment) => segment.segment)
}

/**
 * Counts how often each word occurs.
 *
 * @param words - Words of one text.
 * @returns Occurrences by word.
 */
function countWords(words: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  return counts
}

/**
 * Counts the words of one text for ranking.
 *
 * @param text - Text to count.
 * @returns Its word count and occurrences by word.
 */
function buildRankedTextWords(text: string): RankedTextWords {
  const words = listRankingWords(text)
  return Object.freeze({
    wordCount: words.length,
    wordCounts: countWords(words)
  })
}

/**
 * Calculates how rare a word is among the ranked texts.
 *
 * @param word - Query word.
 * @param textWords - Counted words of every text.
 * @returns The BM25 inverse text frequency of the word, which is positive.
 */
function calculateInverseFrequency(
  word: string,
  textWords: readonly RankedTextWords[]
): number {
  const containingCount = textWords.filter((words) =>
    words.wordCounts.has(word)
  ).length
  const missingCount = textWords.length - containingCount
  return Math.log(1 + (missingCount + 0.5) / (containingCount + 0.5))
}

/**
 * Calculates how well one text matches the query, by the BM25 ranking
 * function.
 *
 * @param input - The text's counted words, the ranked query words, and the
 * average text length.
 * @returns The score; zero when the text contains no query word.
 */
function calculateTextScore(input: TextScoreInput): number {
  const { textWords, averageWordCount } = input
  const lengthFactor =
    1 -
    RANKING_LENGTH_NORMALIZATION +
    (RANKING_LENGTH_NORMALIZATION * textWords.wordCount) / averageWordCount
  let score = 0
  for (const { word, inverseFrequency } of input.queryWords) {
    const frequency = textWords.wordCounts.get(word) ?? 0
    const saturation =
      (frequency * (RANKING_TERM_SATURATION + 1)) /
      (frequency + RANKING_TERM_SATURATION * lengthFactor)
    score += inverseFrequency * saturation
  }
  return score
}

/**
 * Calculates how well each text matches a query, by the BM25 ranking
 * function over their words.
 *
 * @param texts - Texts to rank, at least one.
 * @param queryWords - Distinct words of the query as
 * {@link listRankingWords} lists them, at least one.
 * @returns One score per text, in text order; zero when the text contains no
 * query word. A rarer query word weighs more, a repeated one less each time,
 * and the same word counts more in a shorter text.
 * @remarks Words are found with the runtime's word segmentation, so
 * languages written without spaces are ranked too.
 */
export function calculateRankingScores(
  texts: readonly string[],
  queryWords: readonly string[]
): readonly number[] {
  const textWords = texts.map(buildRankedTextWords)
  const totalWordCount = textWords.reduce(
    (total, words) => total + words.wordCount,
    0
  )
  const averageWordCount = Math.max(totalWordCount / textWords.length, 1)
  const rankedQueryWords = queryWords.map((word) =>
    Object.freeze({
      word,
      inverseFrequency: calculateInverseFrequency(word, textWords)
    })
  )
  return textWords.map((words) =>
    calculateTextScore({
      textWords: words,
      queryWords: rankedQueryWords,
      averageWordCount
    })
  )
}
