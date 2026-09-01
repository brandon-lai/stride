/** §5's obstacle vocabulary, and nothing more. */
export type ObstacleKind =
  /** Low barrier: jump it. */
  | "low"
  /** Overhead barrier: duck it. */
  | "overhead"
  /** Full-lane block: change lane. */
  | "block"
  /** Train-style: occupies one lane for several seconds. */
  | "train";

export type Obstacle = {
  id: number;
  kind: ObstacleKind;
  lane: number;
  /** Distance along the track where it starts. */
  z: number;
  /** Metres of track it occupies. Trains are long by definition. */
  length: number;
};

export type Coin = {
  id: number;
  lane: number;
  z: number;
  /** Height above the ground. Arc coins sit where only a jump reaches them. */
  y: number;
  taken: boolean;
};

/** What the player is doing, independent of how it was triggered (§7.4). */
export type Action = "jumpLeft" | "jumpRight" | "jump" | "duck" | "left" | "right";

export type PlayerState = {
  lane: number;
  /** Lateral position in metres, which lags `lane` during a change. */
  x: number;
  /** Height of the feet. 0 on the ground. */
  y: number;
  vy: number;
  airborne: boolean;
  /** Seconds of duck remaining; 0 when standing. */
  duckFor: number;
};

export type RunState = {
  status: "running" | "dead";
  /** Metres travelled. This is the score (§2). */
  distance: number;
  coins: number;
  /** Current speed in m/s, after ramp, cadence and the §5 cap. */
  speed: number;
  /** §3's cadence multiplier. Keyboard play holds this at 1. */
  cadenceMult: number;
  player: PlayerState;
  obstacles: Obstacle[];
  coinsOnTrack: Coin[];
  /** What killed the run, for the score screen. */
  killedBy: ObstacleKind | null;
  elapsed: number;
  /**
   * Feedback fired this step, drained by the caller. §2 requires audio cues for
   * coin, near miss and collision, and a near miss is not derivable from the
   * outside -- only the engine knows the player passed through a gap they were
   * inside of.
   */
  events: GameEvent[];
};

export type GameEvent = "coin" | "nearMiss" | "collision";

/** Everything the engine needs for one step. Pure in, pure out. */
export type Tick = {
  dt: number;
  actions: Action[];
  /** 0.5..1.3 from cadence (§3); keyboard mode passes 1. */
  cadenceMult: number;
};
