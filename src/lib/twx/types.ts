// Service shapes from singl-web's lib/twx/types.ts, as singl-core's
// twx::api returns them (src-tauri/crates/singl-core/src/twx/api.rs).

export interface ServiceParam {
  name: string
  description: string
  baseType: string
  ordinal: number
  aspects: {
    isRequired?: boolean
    defaultValue?: string
    dataShape?: string
    [key: string]: unknown
  }
}

export interface ServiceResultType {
  name: string
  description: string
  baseType: string
  aspects: {
    dataShape?: string
    [key: string]: unknown
  }
}

export interface ServiceDef {
  name: string
  description: string
  category: string
  parameterDefinitions: ServiceParam[]
  resultType: ServiceResultType
}

export interface EntitySearchResult {
  name: string
  description?: string
}

// XML tokenizer shapes for xmlformat.ts (ported from singl-web's lib/twx/types.ts).

export interface XmlToken {
  type: "cdata" | "tag" | "text"
  value: string
}

export interface ParsedTag {
  name: string
  attrs: string[]
}

export type FilterAttrCallback = (name: string, value: string) => false | true | { name: string; value: string }
