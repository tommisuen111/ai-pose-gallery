export interface PoseItem {
  source?: 'upload'
  /** 是否使用灰阶深度图（Depth Map）代替素体白模 */
  useDepth?: boolean
  id: string
  体系: string
  姿势编号: string
  分类: string
  姿势名称: string
  角度: string
  缩略图: string
  原图: string
  检索: string
}

export interface PoseGroup {
  key: string
  system: string
  number: string
  name: string
  category: string
  items: PoseItem[]
  angles: Record<string, PoseItem>
  order: PoseItem[]
}

export interface CostumeView {
  id: string
  label: string
  缩略图: string
  预览图: string
  原图: string
}

export interface CostumeItem {
  source?: 'upload' | 'charadb' | 'gia-anime' | 'shisei'
  views?: CostumeView[]
  selectedView?: string
  一级分类?: '现实' | '二次元'
  来源?: string
  来源地址?: string
  日文名称?: string
  敏感?: boolean
  id: string
  分类: string
  服装名称: string
  标签: string[]
  关键词: string
  缩略图: string
  预览图: string
  原图: string
  检索: string
}

export interface PortraitItem {
  source?: 'upload'
  id: string
  分区: string
  发长: string
  发型名称: string
  标题: string
  宽: number
  高: number
  字节数: number
  精选: boolean
  热门: boolean
  缩略图: string
  原图: string
  检索: string
}

export interface BodyExample {
  提示词: string
  缩略图: string
  原图: string
}

export interface BodyEntry {
  分组: string
  提示词: string
  中文: string
}

export interface BodyCategory {
  id: string
  名称: string
  简介: string
  示例: BodyExample[]
  词条: BodyEntry[]
}

export interface BodySection {
  名称: string
  分类: BodyCategory[]
}

export interface BodyData {
  来源: {
    标题: string
    网址: string
    作者: string
    说明: string
  }
  更新: string
  体系: BodySection[]
}

// ===== Face (表情) =====
export interface FaceExample {
  提示词: string
  缩略图: string
  原图: string
}

export interface FaceEntry {
  分组: string
  提示词: string
  中文: string
}

export interface FaceCategory {
  id: string
  名称: string
  简介: string
  示例: FaceExample[]
  词条: FaceEntry[]
}

export interface FaceSection {
  名称: string
  分类: FaceCategory[]
}

export interface FaceData {
  来源: {
    标题: string
    网址: string
    作者: string
    说明: string
  }
  更新: string
  体系: FaceSection[]
}

export interface ExtraReferenceImage {
  role?: 'character_sheet'
  id: string
  name: string
  url: string
}

export interface RecipeState {
  portrait: PortraitItem | null
  costume: CostumeItem | null
  pose: PoseItem | null
  /** 已加入配方的人物体型/身材提示词（可多个，自动汇总到总提示词） */
  bodyTags?: string[]
  /** 已加入配方的人物表情提示词，排在身材标签之后 */
  faceTags?: string[]
  workflowImages?: Record<string, ExtraReferenceImage>
  workflowImagesIdentity?: string
  extraImages?: ExtraReferenceImage[]
}

export type ImageProviderId = 'gemini' | 'gpt' | 'qwen' | 'doubao' | 'comfyui'

export interface ProviderEndpointConfig {
  baseUrl: string
  apiKey: string
  model: string
  customModel: string
}

export type ImagePassMode = 'url' | 'base64'

export type WorkflowScalar = string | number | boolean

export interface WorkflowParameterOverrides {
  workflowId: string
  values: Record<string, Record<string, WorkflowScalar>>
}

export interface ComfyUiParams {
  parameterOverrides?: WorkflowParameterOverrides
  workflowPreset: 'qwen2509_3img' | 'qwen2509_2img' | 'qwen21_3img' | 'qwen21_2img' | 'custom'
  workflowJson: string
  promptNodeId: string
  portraitNodeId: string
  costumeNodeId: string
  poseNodeId: string
  stitchedNodeId: string
  randomizeSeed: boolean
  /** 单次生成最长等待秒数 */
  timeoutSec: number
  /** 配置结构版本，用于迁移旧版默认值 */
  configVersion?: number
}

export interface GptParams {
  endpointMode: 'images_edits_json' | 'images_edits' | 'responses' | 'chat'
  size: 'auto' | '1024x1536' | '1024x1024' | '1536x1024'
  quality: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  inputFidelity: 'high' | 'low'
  background: 'auto' | 'opaque' | 'transparent'
  outputFormat: 'png' | 'jpeg' | 'webp'
  moderation: 'auto' | 'low'
}

export interface GeminiParams {
  endpointMode: 'native' | 'openai_chat'
  aspectRatio: '3:4' | '1:1' | '4:3' | '9:16' | '16:9'
  imageSize: '1K' | '2K' | '4K'
}

export interface QwenParams {
  size: '1024*1536' | '1328*1328' | '928*1664' | '1664*928'
  promptExtend: boolean
  watermark: boolean
  negativePrompt: string
  n: number
}

export interface DoubaoParams {
  size: '2K' | '4K' | '1K' | '1728x2304' | '2048x2048' | '1440x2560' | '2560x1440'
  sequentialImageGeneration: 'disabled' | 'auto'
  watermark: boolean
  responseFormat: 'b64_json' | 'url'
}

export interface ApiConfig {
  activeProvider: ImageProviderId
  imagePassMode: ImagePassMode
  useProxy: boolean
  stylePreset: string
  sendStitchedSheet: boolean
  providers: Record<ImageProviderId, ProviderEndpointConfig>
  gptParams: GptParams
  geminiParams: GeminiParams
  qwenParams: QwenParams
  doubaoParams: DoubaoParams
  comfyuiParams: ComfyUiParams
}

export interface GenerationHistoryItem {
  id: string
  createdAt: number
  provider: ImageProviderId
  model: string
  prompt: string
  imageUrl: string
  recipeSummary: string
  snapshot?: GenerationSnapshot
}


export interface GenerationSnapshot {
  recipe: RecipeState
  prompt: string
  settings: Omit<ApiConfig, 'providers'>
  models: Record<ImageProviderId, Pick<ProviderEndpointConfig, 'model' | 'customModel'>>
  submittedWorkflowJson?: string
}
