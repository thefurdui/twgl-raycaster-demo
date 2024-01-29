'use strict'

const canvas = document.querySelector('canvas')
const gl = canvas.getContext('webgl2')
if (!gl) {
  throw new Error('WebGL2 is not supported in your browser')
}

twgl.setDefaults({ attribPrefix: 'a_' })

const m4 = twgl.m4
const v3 = twgl.v3
m4.rotateByEuler = (matrix, rotation) =>
  [m4.rotateX, m4.rotateY, m4.rotateZ].reduce(
    (rotatedMatrix, rotate, idx) => rotate(rotatedMatrix, rotation[idx]),
    matrix
  )

class Display {
  static get aspectRatio() {
    return gl.canvas.clientWidth / gl.canvas.clientHeight
  }

  static get dpr() {
    // In order for zoom to be detected properly, there should be no inspector opened in browser side panel.
    // Zoom is necessary to calculate a proper DPR value when the page is zoomed out.
    const zoomFactor = (window.outerWidth - 10) / window.innerWidth
    const dpr = window.devicePixelRatio || 1

    if (zoomFactor < 1) return dpr / zoomFactor
    return dpr
  }
}

class Controls {
  constructor() {
    const planeScaleXInput = document.querySelector('#plane-scale-x')
    const planeScaleYInput = document.querySelector('#plane-scale-y')

    const applyScaling = () => {
      scene.planes.forEach((plane) => plane.updateScale())
      scene.render()
    }

    planeScaleXInput.addEventListener('input', (e) => {
      Plane.scaleX = e.target.value
      applyScaling()
    })

    planeScaleYInput.addEventListener('input', (e) => {
      Plane.scaleY = e.target.value
      applyScaling()
    })
  }
}

class Scene {
  static clearColor = [1, 1, 1, 1]

  constructor({ planesAmount = 1 }) {
    gl.clearColor(...Scene.clearColor)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
    gl.depthMask(true)

    this.planes = []
    for (let i = 0; i < planesAmount; i++) {
      this.planes.push(new Plane())
    }

    const resizeObserver = new ResizeObserver(() => this.render())
    resizeObserver.observe(gl.canvas)
  }

  get words() {
    return this.planes.flatMap((plane) => plane.visibleWords)
  }

  get objects() {
    return [...Scene.planes, ...Scene.words]
  }

  render() {
    // Resize the canvas and update the viewport
    twgl.resizeCanvasToDisplaySize(gl.canvas, Display.dpr)
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)

    // Clear the canvas
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    this.renderPlanes()
    this.renderText()
  }

  renderPlanes() {
    this.planes.forEach((plane) => {
      gl.disable(gl.BLEND)
      gl.useProgram(Plane.programInfo.program)
      gl.bindVertexArray(Plane.vao)
      twgl.setUniforms(Plane.programInfo, plane.uniforms)
      twgl.drawBufferInfo(gl, Plane.bufferInfo)
    })
  }

  renderText() {
    this.planes.forEach((plane) => {
      plane.visibleWords.forEach((word) => {
        word.position
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.useProgram(Word.programInfo.program)
        gl.bindVertexArray(Word.vao)
        twgl.setUniforms(Word.programInfo, word.uniforms)
        twgl.drawBufferInfo(gl, Word.bufferInfo)
      })
    })
  }
}

class Camera {
  static near = 1
  static far = 2000
  static fov = Math.PI / 3

  static position = [0, 0, 1000]
  static target = [0, 0, 0]
  static up = [0, 1, 0]

  static get projectionMatrix() {
    return m4.perspective(
      Camera.fov,
      Display.aspectRatio,
      Camera.near,
      Camera.far
    )
  }

  static localMatrix = m4.lookAt(Camera.position, Camera.target, Camera.up)
  static viewMatrix = m4.inverse(Camera.localMatrix)
}

class Raycaster {
  constructor() {
    gl.canvas.addEventListener('mousemove', (e) => {
      this.hoveredObjectId = null

      const ray = Raycaster.getRayFromMouse(e)
      const objectId = Raycaster.getIntersectedObjectId(ray, scene.words)

      if (objectId !== this.hoveredObjectId) {
        this.hoveredObjectId = objectId
        scene.render()
      }
    })
  }

  static getRayFromMouse(e) {
    // Convert the mouse position to normalized device coordinates
    let x = ((e.clientX * Display.dpr) / canvas.width) * 2 - 1
    let y = -((e.clientY * Display.dpr) / canvas.height) * 2 + 1

    const endNDC = [x, y, 1]
    const startNDC = [x, y, 0]

    // Calculate the view-projection matrix
    const viewProjectionMatrix = m4.multiply(
      Camera.projectionMatrix,
      Camera.viewMatrix
    )

    // Calculate the inverse of the view-projection matrix
    const inverseViewProjectionMatrix = m4.inverse(viewProjectionMatrix)

    // Transform the end point from NDC to world coordinates
    const startWorld = m4.transformPoint(inverseViewProjectionMatrix, startNDC)
    const endWorld = m4.transformPoint(inverseViewProjectionMatrix, endNDC)

    // The direction of the ray is the normalized vector from the start point to the end point
    const direction = v3.normalize(v3.subtract(endWorld, startWorld))

    // Return the origin and direction as the ray
    return {
      origin: startWorld,
      direction
    }
  }

  static getIntersectionDistance(ray, object) {
    const denominator = v3.dot(object.normal, ray.direction)

    const point = object.worldPosition
    const rotation = object.worldRotation

    // If the denominator is close to 0, the ray is parallel to the plane
    if (Math.abs(denominator) <= 1e-6) return false

    const distance =
      v3.dot(object.normal, v3.subtract(point, ray.origin)) / denominator

    if (distance < 0) return false

    const intersectionPoint = v3.add(
      ray.origin,
      v3.mulScalar(ray.direction, distance)
    )

    const rotationX = m4.rotationX(rotation[0])
    const rotationY = m4.rotationY(rotation[1])
    const rotationZ = m4.rotationZ(rotation[2])

    const rotationMatrix = m4.multiply(
      m4.multiply(rotationX, rotationY),
      rotationZ
    )

    const inverseRotation = m4.inverse(rotationMatrix)

    const localIntersectionPoint = v3.subtract(intersectionPoint, point)

    let alignedLocalIntersectionPoint = m4.transformPoint(
      inverseRotation,
      localIntersectionPoint
    )

    // Check if the intersection point is within the plane's boundaries
    const isWithinBoundaries =
      Math.abs(alignedLocalIntersectionPoint[0]) <= object.width / 2 &&
      Math.abs(alignedLocalIntersectionPoint[1]) <= object.height / 2

    if (isWithinBoundaries) return distance

    return false
  }

  static getIntersectedObjectId(ray, objects) {
    let closestT = Infinity
    let closestObjectId = null

    objects.forEach((object) => {
      const t = this.getIntersectionDistance(ray, object)

      if (t !== false && t < closestT) {
        closestT = t
        closestObjectId = object.id
      }
    })

    return closestObjectId
  }
}

class Plane {
  static vertexShaderSrc = `#version 300 es
    precision highp float;
    in vec4 a_position;
    uniform mat4 u_matrix;

    void main() {
      gl_Position = u_matrix * a_position;
    }
  `

  static fragmentShaderSrc = `#version 300 es
    precision highp float;
    uniform vec4 u_color;
    out vec4 outColor;

    void main() {
      outColor = u_color;
    }
  `

  static programInfo = twgl.createProgramInfo(gl, [
    Plane.vertexShaderSrc,
    Plane.fragmentShaderSrc
  ])

  static quadBufferSideSize = 200

  static bufferInfo = twgl.primitives.createXYQuadBufferInfo(
    gl,
    Plane.quadBufferSideSize
  )

  static vao = twgl.createVAOFromBufferInfo(
    gl,
    Plane.programInfo,
    Plane.bufferInfo
  )

  static color = [0.95, 0.87, 0.81, 1.0]

  static text = `Lorem ipsum dolor sit amet, consectetur adipiscing elit, 
  sed do eiusmod tempor incididunt ut labore et dolore magna 
  aliqua. Ut enim ad minim veniam, quis nostrud exercitation 
  ullamco laboris nisi ut aliquip ex ea commodo consequat.
  Duis aute irure dolor in repre henderit in voluptate velit 
  esse cillum dolore eu fugiat nulla pariatur.
  `

  static textWords = Plane.text
    .split(' ')
    .map((word) => word.replace('\n', ''))
    .filter((word) => word.trim() !== '')

  static textSpaceWidth = 5

  static randomPositionBoundaries = [300, 200, 500]

  static scaleX = 1
  static scaleY = 1

  constructor() {
    // Use uuid's in production
    this.id = Date.now() + Math.random()

    const { position, rotation } = Plane.getRandomTransform()
    this.localRotation = rotation
    this.height = Plane.height
    this.width = Plane.width

    this.localMatrix = m4.translate(m4.identity(), position)
    this.localMatrix = m4.rotateByEuler(this.localMatrix, this.localRotation)

    this.baseTransformMatrix = this.localMatrix

    this.normal = m4.transformDirection(this.worldViewMatrix, [0, 0, 1])

    this.words = []
    this.visibleWords = this.words
    Plane.textWords.forEach((word) => this.words.push(new Word(word, this)))
    this.alignText()
  }

  get worldMatrix() {
    return m4.multiply(this.localMatrix, m4.identity())
  }

  get worldPosition() {
    return this.worldMatrix.slice(12, 15)
  }

  get localPosition() {
    return this.localMatrix.slice(12, 15)
  }

  get worldRotation() {
    return this.localRotation
  }

  get worldViewMatrix() {
    return m4.multiply(Camera.viewMatrix, this.worldMatrix)
  }

  get projectionWorldViewMatrix() {
    return m4.multiply(Camera.projectionMatrix, this.worldViewMatrix)
  }

  get uniforms() {
    return {
      u_matrix: this.projectionWorldViewMatrix,
      u_color: Plane.color
    }
  }

  static get width() {
    return Plane.quadBufferSideSize * Plane.scaleX
  }

  static get height() {
    return Plane.quadBufferSideSize * Plane.scaleY
  }

  static get textXYOrigin() {
    return [Plane.width / 2, Plane.height / 2 - Word.lineHeight / 2]
  }

  static getRandomTransform = () => {
    const position = Plane.randomPositionBoundaries.map(
      (boundary) => Math.random() * boundary * 2 - boundary
    )

    const rotation = [
      (Math.random() - 1 / 2) * (Math.PI / 2),
      (Math.random() - 1 / 2) * (Math.PI / 2),
      Math.random() * Math.PI * 2
    ]

    return { position, rotation }
  }

  updateScale() {
    const scale = [Plane.scaleX, Plane.scaleY, 1]
    this.localMatrix = m4.scale(this.baseTransformMatrix, scale)
    this.alignText()
  }

  alignText() {
    let line = 0
    let lineWidth = 0
    let isOverflown = false
    this.visibleWords = []

    for (const word of this.words) {
      if (isOverflown) continue

      const wordWithSpaceWidth = word.width + Plane.textSpaceWidth

      lineWidth += wordWithSpaceWidth
      if (lineWidth > Plane.width) {
        line++
        lineWidth = wordWithSpaceWidth
      }

      const lineHeight = (line + 1) * Word.lineHeight
      if (lineHeight > Plane.height) {
        isOverflown = true
        continue
      }

      const [xOrigin, yOrigin] = Plane.textXYOrigin

      const translationVector = [
        lineWidth - word.width / 2 - xOrigin,
        yOrigin - line * Word.lineHeight,
        0
      ]

      word.localMatrix = m4.translate(
        word.baseTransformMatrix,
        translationVector
      )

      this.visibleWords.push(word)
    }
  }
}

class Word {
  static vertexShaderSrc = `#version 300 es
    in vec4 a_position;
    in vec2 a_texcoord;
    uniform mat4 u_matrix;
    out vec2 v_texcoord;

    void main() {
      gl_Position = u_matrix * a_position;
      v_texcoord = a_texcoord;
    }
  `

  static fragmentShaderSrc = `#version 300 es
    precision highp float;
    in vec2 v_texcoord;
    uniform sampler2D u_texture;
    out vec4 outColor;

    void main() {
      outColor = texture(u_texture, v_texcoord);
    }
  `
  static programInfo = twgl.createProgramInfo(gl, [
    Word.vertexShaderSrc,
    Word.fragmentShaderSrc
  ])

  static bufferInfo = twgl.primitives.createXYQuadBufferInfo(gl, 1)

  static vao = twgl.createVAOFromBufferInfo(
    gl,
    Word.programInfo,
    Word.bufferInfo
  )

  static hoverColor = '#990F3D'

  static font = '32px sans-serif'

  static lineHeight = 40

  static textureCanvasContext = document
    .createElement('canvas')
    .getContext('2d')

  constructor(word, parent) {
    this.id = Date.now() + Math.random()
    this.word = word
    this.parent = parent

    const { texture: defaultTexture, width, height } = Word.createTexture(word)
    const { texture: hoveredTexture } = Word.createTexture(
      word,
      Word.hoverColor
    )

    this.defaultTexture = defaultTexture
    this.hoveredTexture = hoveredTexture
    this.width = width
    this.height = height

    this.normal = parent.normal

    this.worldRotation = parent.worldRotation

    // Introduce small Z Offset to resolve z fighting with plane
    this.localMatrix = m4.translate(m4.identity(), [0, 0, 0.5])
    this.baseTransformMatrix = this.localMatrix
  }

  get worldMatrix() {
    const worldBaseTransformMatrix = m4.multiply(
      this.baseTransformMatrix,
      this.parent.worldMatrix
    )

    return m4.translate(
      worldBaseTransformMatrix,
      v3.divide(this.localPosition, [Plane.scaleX, Plane.scaleY, 1])
    )
  }

  get viewWorldMatrix() {
    // Needed for text the text quad to be scaled to the texture width and height
    // Won't work if scaling is applied earlier
    const scaledWorldMatrix = m4.scale(this.worldMatrix, [
      this.width / Plane.scaleX,
      this.height / Plane.scaleY,
      1
    ])
    return m4.multiply(Camera.viewMatrix, scaledWorldMatrix)
  }

  get worldPosition() {
    return this.worldMatrix.slice(12, 15)
  }

  get localPosition() {
    return this.localMatrix.slice(12, 15)
  }

  get projectionViewWorldMatrix() {
    return m4.multiply(Camera.projectionMatrix, this.viewWorldMatrix)
  }

  get uniforms() {
    const isSelected = raycaster?.hoveredObjectId === this.id
    return {
      u_matrix: this.projectionViewWorldMatrix,
      u_texture: isSelected ? this.hoveredTexture : this.defaultTexture
    }
  }

  static createTexture(word, color) {
    const dpr = Display.dpr

    const textCanvas = Word.makeTextCanvas(word, color)
    const textWidth = textCanvas.width / dpr
    const textHeight = textCanvas.height / dpr
    const textTex = gl.createTexture()

    gl.bindTexture(gl.TEXTURE_2D, textTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      textCanvas
    )

    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    return {
      texture: textTex,
      width: textWidth,
      height: textHeight
    }
  }

  static makeTextCanvas = (text, color = '#000') => {
    const textCtx = Word.textureCanvasContext
    const dpr = Display.dpr

    textCtx.font = Word.font

    textCtx.canvas.width = textCtx.measureText(text).width * dpr
    textCtx.canvas.height = Word.lineHeight * dpr

    // After changing `width` and `height` of the canvas, the context is reset.
    // So, we need to set the font property once again.
    // Reference: https://www.w3.org/html/wg/spec/the-canvas-element.html

    textCtx.font = Word.font

    textCtx.scale(dpr, dpr)

    textCtx.textAlign = 'center'
    textCtx.textBaseline = 'middle'
    textCtx.fillStyle = color

    const { width, height } = textCtx.canvas

    textCtx.clearRect(0, 0, width, height)
    textCtx.fillText(text, width / (2 * dpr), height / (2 * dpr))

    return textCtx.canvas
  }
}

// Initialize the scene
const scene = new Scene({ planesAmount: 3 })
const raycaster = new Raycaster()
new Controls()
