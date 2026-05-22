// Familista — Quantum-Ready Research Interfaces (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// NO ACTUAL QUANTUM DEPENDENCY. NO DB MODELS. These are TS-only contracts
// that document where future quantum-enabled algorithms (annealing,
// pattern search, scheduling) would slot in.
//
// All adapters here are no-op stubs that document the interface.

export interface QuantumOptimizationAdapter {
  /** Adapter name: "Dwave" | "IBM_Q" | "AWS_Braket" | "STUB" */
  readonly name: string;
  /**
   * Solve a quadratic unconstrained binary optimisation (QUBO).
   * Returns the optimal assignment + energy. Stub returns greedy heuristic.
   */
  solveQUBO(input: {
    variables: number;
    qMatrix:   number[][];      // symmetric square matrix
    timeoutMs?: number;
  }): Promise<{ assignment: number[]; energy: number; engine: string }>;
}

export interface QuantumSchedulingExperiment {
  readonly name: string;
  /**
   * Schedule N tasks across M machines minimising makespan. Stub falls
   * back to longest-processing-time-first greedy.
   */
  schedule(input: {
    tasks:     Array<{ id: string; durationMs: number; deps?: string[] }>;
    machines:  number;
  }): Promise<{ schedule: Record<string, number>; makespanMs: number; engine: string }>;
}

export interface QuantumPatternSearch {
  readonly name: string;
  /**
   * Search for tactical patterns in an event sequence. Stub returns
   * O(n²) brute-force first match.
   */
  search<T>(input: {
    sequence: T[];
    pattern:  T[];
    matcher?: (a: T, b: T) => boolean;
  }): Promise<{ matches: number[]; engine: string }>;
}

/**
 * QuantumInferenceBoundary documents the crypto + privacy rotation policy
 * that becomes important when post-quantum cryptography is deployed.
 * No method body yet — this is a research note in code form.
 */
export interface QuantumInferenceBoundary {
  readonly recommendedKemForFederated: 'kyber-768' | 'kyber-1024' | 'classical-hkdf';
  readonly recommendedSigForDevices:   'dilithium-3' | 'ed25519';
  /**
   * Returns whether the current platform configuration is considered
   * "quantum-safe" against current threat models. Stub always returns
   * "transitional" until post-quantum primitives land.
   */
  posture(): 'classical' | 'transitional' | 'post-quantum';
}

// ─────────────────────────────────────────────────────────────────────────
// Default STUB adapters (deterministic, dependency-free).
// ─────────────────────────────────────────────────────────────────────────

export class StubQuantumOptimization implements QuantumOptimizationAdapter {
  readonly name = 'STUB';
  async solveQUBO(input: { variables: number; qMatrix: number[][]; timeoutMs?: number }): Promise<{ assignment: number[]; energy: number; engine: string }> {
    // Greedy: each variable independently chooses 0 or 1 by sign of its diagonal.
    const assignment: number[] = [];
    let energy = 0;
    for (let i = 0; i < input.variables; i++) {
      const d = input.qMatrix[i]?.[i] ?? 0;
      assignment.push(d < 0 ? 1 : 0);
      energy += d * (assignment[i] || 0);
    }
    return { assignment, energy, engine: 'STUB' };
  }
}

export class StubQuantumScheduling implements QuantumSchedulingExperiment {
  readonly name = 'STUB';
  async schedule(input: { tasks: Array<{ id: string; durationMs: number; deps?: string[] }>; machines: number }): Promise<{ schedule: Record<string, number>; makespanMs: number; engine: string }> {
    // LPT-first greedy across machines.
    const sorted = [...input.tasks].sort((a, b) => b.durationMs - a.durationMs);
    const finishAt: number[] = new Array(Math.max(1, input.machines)).fill(0);
    const schedule: Record<string, number> = {};
    for (const t of sorted) {
      let mIdx = 0;
      for (let i = 1; i < finishAt.length; i++) if (finishAt[i] < finishAt[mIdx]) mIdx = i;
      schedule[t.id] = mIdx;
      finishAt[mIdx] += t.durationMs;
    }
    return { schedule, makespanMs: Math.max(...finishAt), engine: 'STUB' };
  }
}

export class StubQuantumPatternSearch implements QuantumPatternSearch {
  readonly name = 'STUB';
  async search<T>(input: { sequence: T[]; pattern: T[]; matcher?: (a: T, b: T) => boolean }): Promise<{ matches: number[]; engine: string }> {
    const eq = input.matcher ?? ((a, b) => a === b);
    const matches: number[] = [];
    outer: for (let i = 0; i <= input.sequence.length - input.pattern.length; i++) {
      for (let j = 0; j < input.pattern.length; j++) if (!eq(input.sequence[i + j], input.pattern[j])) continue outer;
      matches.push(i);
    }
    return { matches, engine: 'STUB' };
  }
}

export class StubQuantumInferenceBoundary implements QuantumInferenceBoundary {
  readonly recommendedKemForFederated = 'kyber-768' as const;
  readonly recommendedSigForDevices   = 'ed25519'   as const;
  posture(): 'classical' | 'transitional' | 'post-quantum' { return 'transitional'; }
}

// ─────────────────────────────────────────────────────────────────────────
// Registry — single instance + getter for callers.
// ─────────────────────────────────────────────────────────────────────────

export const quantumRegistry = {
  optimization: new StubQuantumOptimization()       as QuantumOptimizationAdapter,
  scheduling:   new StubQuantumScheduling()         as QuantumSchedulingExperiment,
  pattern:      new StubQuantumPatternSearch()      as QuantumPatternSearch,
  boundary:     new StubQuantumInferenceBoundary()  as QuantumInferenceBoundary,
};
