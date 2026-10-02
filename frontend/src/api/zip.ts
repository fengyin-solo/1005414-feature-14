// 最小 ZIP 打包器：仅存储（STORE，不压缩），文件名按 UTF-8 写入并置通用标志位。
// 浏览器端零依赖，把若干文本条目打成一个 .zip 供下载后直接分发。

export type ZipEntry = {
  name: string
  content: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder()
  const fileParts: BlobPart[] = []
  const centralParts: BlobPart[] = []
  let offset = 0
  let centralSize = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = encoder.encode(entry.content)
    const crc = crc32(data)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // local file header 签名
    local.setUint16(4, 20, true) // 解压所需版本
    local.setUint16(6, 0x0800, true) // 标志位：文件名 UTF-8
    local.setUint16(8, 0, true) // 压缩方式：STORE
    local.setUint16(10, 0, true) // 修改时间
    local.setUint16(12, 0x21, true) // 修改日期：1980-01-01
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true) // 压缩后大小
    local.setUint32(22, data.length, true) // 原始大小
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true) // 扩展字段长度
    fileParts.push(new Uint8Array(local.buffer), nameBytes, data)

    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true) // central directory 签名
    central.setUint16(4, 20, true) // 压缩所用版本
    central.setUint16(6, 20, true) // 解压所需版本
    central.setUint16(8, 0x0800, true) // 标志位：文件名 UTF-8
    central.setUint16(10, 0, true) // 压缩方式：STORE
    central.setUint16(12, 0, true) // 修改时间
    central.setUint16(14, 0x21, true) // 修改日期
    central.setUint32(16, crc, true)
    central.setUint32(20, data.length, true)
    central.setUint32(24, data.length, true)
    central.setUint16(28, nameBytes.length, true)
    // 30~41 字节保持 0：扩展字段、注释、磁盘号、内外部属性
    central.setUint32(42, offset, true) // local header 偏移
    centralParts.push(new Uint8Array(central.buffer), nameBytes)
    centralSize += 46 + nameBytes.length

    offset += 30 + nameBytes.length + data.length
  }

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // EOCD 签名
  end.setUint16(8, entries.length, true) // 本盘条目数
  end.setUint16(10, entries.length, true) // 条目总数
  end.setUint32(12, centralSize, true) // central directory 大小
  end.setUint32(16, offset, true) // central directory 偏移

  return new Blob([...fileParts, ...centralParts, new Uint8Array(end.buffer)], {
    type: 'application/zip',
  })
}
