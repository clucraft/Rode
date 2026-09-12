// Minimal typings for the parts of ggencoder that Rode uses.
declare module 'ggencoder' {
  export interface AisDecodeResult {
    valid: boolean;
    error: string;
    aistype: number;
    mmsi: number | string;
    channel: string;
    class: 'A' | 'B' | undefined;
    navstatus: number | undefined;
    /** degrees */
    lat: number | undefined;
    /** degrees */
    lon: number | undefined;
    /** knots */
    sog: number | undefined;
    /** degrees */
    cog: number | undefined;
    /** degrees, 511 = not available */
    hdg: number | undefined;
    rot: number | undefined;
    shipname: string | undefined;
    callsign: string | undefined;
    imo: number | undefined;
    /** ship/cargo type code */
    cargo: number | undefined;
    length: number | undefined;
    width: number | undefined;
    draught: number | undefined;
    destination: string | undefined;
    utc: number | undefined;
    part: number | undefined;
  }

  export class AisDecode {
    constructor(sentence: string, session: Record<string, unknown>);
  }
  export interface AisDecode extends AisDecodeResult {}

  export interface AisEncodeOptions {
    aistype: number;
    repeat?: number;
    mmsi: number | string;
    navstatus?: number;
    /** degrees */
    lat?: number;
    lon?: number;
    /** knots */
    sog?: number;
    /** degrees */
    cog?: number;
    hdg?: number;
    rot?: number;
    shipname?: string;
    callsign?: string;
    imo?: number;
    cargo?: number;
    dimA?: number;
    dimB?: number;
    dimC?: number;
    dimD?: number;
    draught?: number;
    destination?: string;
    part?: number;
    aisid?: number;
  }

  export class AisEncode {
    constructor(options: AisEncodeOptions);
    valid: boolean;
    nmea: string;
  }
}

declare module 'ggencoder' {
  const GGencoder: { AisDecode: typeof AisDecode; AisEncode: typeof AisEncode };
  export default GGencoder;
}
