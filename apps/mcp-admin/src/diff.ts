/**
 * Diff unificado mínimo (LCS por líneas) para `agentos.prompts.diff`.
 * Sin dependencias: los prompts son texto corto/mediano y un O(n·m) basta.
 * Si el producto n·m se dispara, cae a un reemplazo completo (sigue siendo
 * un diff unificado válido, solo que sin líneas de contexto compartidas).
 */

interface DiffOp {
  type: " " | "-" | "+";
  line: string;
}

const MAX_CELLS = 4_000_000;

function diffOps(aLines: string[], bLines: string[]): DiffOp[] {
  const n = aLines.length;
  const m = bLines.length;
  if (n * m > MAX_CELLS) {
    return [
      ...aLines.map((line): DiffOp => ({ type: "-", line })),
      ...bLines.map((line): DiffOp => ({ type: "+", line })),
    ];
  }
  // LCS clásico: dp[i][j] = LCS de a[i..] y b[j..]
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        aLines[i] === bLines[j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ type: " ", line: aLines[i]! });
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      ops.push({ type: "-", line: aLines[i]! });
      i++;
    } else {
      ops.push({ type: "+", line: bLines[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "-", line: aLines[i++]! });
  while (j < m) ops.push({ type: "+", line: bLines[j++]! });
  return ops;
}

export interface UnifiedDiffOptions {
  fromLabel: string;
  toLabel: string;
  context?: number;
}

/** Diff unificado estándar (`--- from`, `+++ to`, hunks `@@`). "" si no hay cambios. */
export function unifiedDiff(a: string, b: string, opts: UnifiedDiffOptions): string {
  if (a === b) return "";
  const context = opts.context ?? 3;
  const ops = diffOps(a.split("\n"), b.split("\n"));

  // Índices de ops con cambio.
  const changed = ops.map((op) => op.type !== " ");
  if (!changed.some(Boolean)) return "";

  const lines: string[] = [`--- ${opts.fromLabel}`, `+++ ${opts.toLabel}`];

  // Agrupa en hunks con `context` líneas de contexto.
  let hunkStart = -1;
  let lastChange = -1;
  const hunks: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < ops.length; k++) {
    if (!changed[k]) continue;
    if (hunkStart === -1 || k - lastChange > context * 2) {
      if (hunkStart !== -1) hunks.push({ start: hunkStart, end: Math.min(ops.length - 1, lastChange + context) });
      hunkStart = Math.max(0, k - context);
    }
    lastChange = k;
  }
  if (hunkStart !== -1) hunks.push({ start: hunkStart, end: Math.min(ops.length - 1, lastChange + context) });

  // Números de línea originales por op.
  let aLine = 1;
  let bLine = 1;
  const positions = ops.map((op) => {
    const pos = { a: aLine, b: bLine };
    if (op.type !== "+") aLine++;
    if (op.type !== "-") bLine++;
    return pos;
  });

  for (const hunk of hunks) {
    let aCount = 0;
    let bCount = 0;
    for (let k = hunk.start; k <= hunk.end; k++) {
      const t = ops[k]!.type;
      if (t !== "+") aCount++;
      if (t !== "-") bCount++;
    }
    const aStart = aCount === 0 ? positions[hunk.start]!.a - 1 : positions[hunk.start]!.a;
    const bStart = bCount === 0 ? positions[hunk.start]!.b - 1 : positions[hunk.start]!.b;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let k = hunk.start; k <= hunk.end; k++) {
      lines.push(`${ops[k]!.type}${ops[k]!.line}`);
    }
  }
  return lines.join("\n");
}
