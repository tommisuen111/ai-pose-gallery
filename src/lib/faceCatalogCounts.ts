import faceData from '../../data/face-zh.json'
import type { FaceData } from '@/types/gallery'
import { countFaceCatalog, type FaceCatalogCounts } from './faceCatalog'

/** 与人物表情库页面使用同一份 canonical JSON 和同一套计数函数。 */
export const FACE_CATALOG_COUNTS: FaceCatalogCounts = countFaceCatalog(faceData as FaceData)
