package io.github.sayach.dshmobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.Camera
import android.os.Bundle
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.SurfaceHolder
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/** QR pairing scanner with uniformly cropped preview, pinch/double-tap zoom, and zoom buttons. */
@Suppress("DEPRECATION")
class ScanActivity : Activity(), SurfaceHolder.Callback {
    private var camera: Camera? = null
    private var cameraInfo = Camera.CameraInfo()
    private var cameraRotation = -1
    private var previewWidth = 0
    private var previewHeight = 0
    private var previewReady = false
    private var resumed = false
    private var decoding = false
    private var finished = false
    private lateinit var preview: ScannerPreview
    private lateinit var previewContainer: FrameLayout
    private lateinit var scanFrame: View
    private lateinit var scanHint: TextView
    private lateinit var zoomOut: ImageButton
    private lateinit var zoomIn: ImageButton
    private lateinit var zoomLabel: TextView
    private var zoom = ScannerZoomState(0, null)

    /**
     * The scanner is a second screen with its own hint and labels, so it needs the same base
     * context treatment as MainActivity: without this it would keep following the system
     * language after the user picked one in Settings.
     */
    override fun attachBaseContext(newBase: Context) {
        val language = newBase.getSharedPreferences(LocalePreference.PREFERENCES_NAME, MODE_PRIVATE)
            .getString(LocalePreference.KEY, null)
        super.attachBaseContext(LocalePreference.wrap(newBase, language))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureEdgeToEdgeWindow(window)
        applyStatusBarIconContrast(window, Color.BLACK)
        setContentView(buildInterface())
        applySafeAreaInsets(previewContainer)
        preview.holder.addCallback(this)
        installGestures()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        openCamera()
    }

    override fun onPause() {
        resumed = false
        releaseCamera()
        super.onPause()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        previewReady = true
        openCamera()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        // The Surface can be larger than its viewport after crop; only the parent owns viewport size.
        updatePreviewGeometry()
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        previewReady = false
        releaseCamera()
    }

    private fun installGestures() {
        var multiTouch = false
        val taps = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(event: MotionEvent): Boolean = true
            override fun onDoubleTap(event: MotionEvent): Boolean {
                applyZoom(if (zoom.requestedRatio > 1.5f) 1f else 2f)
                return true
            }
        })
        val scales = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                applyZoom(zoom.requestedRatio * detector.scaleFactor)
                return true
            }
        }).apply { isQuickScaleEnabled = false }
        preview.gestureEvents = { event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) multiTouch = false
            if (event.pointerCount > 1 && !multiTouch) {
                multiTouch = true
                val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
                taps.onTouchEvent(cancel)
                cancel.recycle()
            }
            scales.onTouchEvent(event)
            if (!multiTouch) taps.onTouchEvent(event)
        }
    }

    private fun applyZoom(desired: Float) {
        val cam = camera ?: return
        if (!zoom.supported) return
        try {
            val params = cam.parameters
            if (!params.isZoomSupported) return disableZoom()
            val index = zoom.request(desired)
            if (index != params.zoom) {
                params.zoom = index
                cam.parameters = params
            }
            zoom.applied(index)
            updateZoomControls()
        } catch (error: RuntimeException) {
            // Camera hardware can reject updates after interruption; scanning remains available.
            disableZoom()
            Toast.makeText(this, R.string.scan_zoom_unavailable, Toast.LENGTH_SHORT).show()
        }
    }

    private fun disableZoom() {
        zoom = ScannerZoomState(0, null)
        updateZoomControls()
    }

    private fun updateZoomControls() {
        zoomOut.isEnabled = zoom.supported && zoom.currentIndex > 0
        zoomIn.isEnabled = zoom.supported && zoom.currentIndex < zoom.maxIndex
        zoomOut.alpha = if (zoomOut.isEnabled) 1f else 0.45f
        zoomIn.alpha = if (zoomIn.isEnabled) 1f else 0.45f
        zoomLabel.text = getString(R.string.scan_zoom_ratio, zoom.actualRatio)
        zoomLabel.contentDescription = getString(R.string.scan_zoom_current, zoom.actualRatio)
    }

    private fun buildInterface(): View {
        val root = object : FrameLayout(this) {
            override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
                super.onLayout(changed, left, top, right, bottom)
                // Padding can change with safe-area insets even when these outer bounds stay identical.
                if (camera == null) openCamera() else updatePreviewGeometry()
            }
        }.apply { setBackgroundColor(Color.BLACK) }
        previewContainer = root
        preview = ScannerPreview(this).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        root.addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))

        scanFrame = View(this).apply {
            background = GradientDrawable().apply {
                setColor(Color.TRANSPARENT)
                setStroke(dp(2), Color.WHITE)
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        root.addView(scanFrame, FrameLayout.LayoutParams(dp(260), dp(260), Gravity.CENTER))

        scanHint = TextView(this).apply {
            text = getString(R.string.scan_hint)
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(dp(16), 0, dp(16), 0)
        }
        root.addView(scanHint, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(80) })

        val controls = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { setColor(Color.BLACK); cornerRadius = dp(24).toFloat() }
            setPadding(dp(8), 0, dp(8), 0)
        }
        fun zoomButton(label: Int, glyph: Int, direction: Int): ImageButton = ImageButton(this).apply {
            setImageResource(glyph)
            contentDescription = getString(label)
            minimumWidth = dp(48)
            minimumHeight = dp(48)
            setPadding(0, 0, 0, 0)
            val styled = obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackgroundBorderless))
            background = styled.getDrawable(0)
            styled.recycle()
            setOnClickListener { applyZoom(zoom.stepRatio(direction)) }
        }
        zoomOut = zoomButton(R.string.scan_zoom_out, R.drawable.ic_scan_zoom_out, -1)
        zoomIn = zoomButton(R.string.scan_zoom_in, R.drawable.ic_scan_zoom_in, 1)
        zoomLabel = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(8), 0)
            minWidth = dp(56)
        }
        controls.addView(zoomOut, LinearLayout.LayoutParams(dp(48), dp(48)))
        controls.addView(zoomLabel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(48)))
        controls.addView(zoomIn, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(controls, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(48),
            Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(16) })
        updateZoomControls()

        val close = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            imageTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
            setBackgroundColor(Color.TRANSPARENT)
            contentDescription = getString(R.string.scan_close)
            setOnClickListener { finish() }
        }
        root.addView(close, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.START).apply {
            topMargin = dp(16)
            marginStart = dp(16)
        })
        return root
    }

    private fun openCamera() {
        val width = previewContainer.width - previewContainer.paddingLeft - previewContainer.paddingRight
        val height = previewContainer.height - previewContainer.paddingTop - previewContainer.paddingBottom
        if (finished || !resumed || !previewReady || camera != null || width <= 0 || height <= 0) return
        try {
            val ids = 0 until Camera.getNumberOfCameras()
            val id = ids.firstOrNull {
                Camera.getCameraInfo(it, cameraInfo)
                cameraInfo.facing == Camera.CameraInfo.CAMERA_FACING_BACK
            } ?: ids.firstOrNull() ?: throw IllegalStateException("camera unavailable")
            Camera.getCameraInfo(id, cameraInfo)
            val cam = Camera.open(id)
            camera = cam
            cameraRotation = displayOrientation()
            val params = cam.parameters
            val focusModes = params.supportedFocusModes.orEmpty()
            if (Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE in focusModes) {
                params.focusMode = Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
            } else if (Camera.Parameters.FOCUS_MODE_AUTO in focusModes) {
                params.focusMode = Camera.Parameters.FOCUS_MODE_AUTO
            }
            val sizes = params.supportedPreviewSizes?.map { PreviewLayoutPolicy.Size(it.width, it.height) }.orEmpty()
            val size = PreviewLayoutPolicy.choosePreviewSize(sizes, width, height, cameraRotation % 180 != 0)
                ?: throw IllegalStateException("camera has no supported preview size")
            params.setPreviewSize(size.width, size.height)
            zoom = ScannerZoomState(if (params.isZoomSupported) params.maxZoom else 0,
                if (params.isZoomSupported) params.zoomRatios?.toList() else null)
            if (zoom.supported) params.zoom = 0
            cam.parameters = params
            previewWidth = size.width
            previewHeight = size.height
            cam.setDisplayOrientation(cameraRotation)
            cam.setPreviewDisplay(preview.holder)
            updatePreviewGeometry()
            updateZoomControls()
            cam.setPreviewCallback { data, _ -> onPreviewFrame(data) }
            cam.startPreview()
        } catch (error: Exception) {
            finished = true
            releaseCamera()
            Toast.makeText(this, R.string.camera_unavailable, Toast.LENGTH_LONG).show()
            finish()
        }
    }

    private fun displayOrientation(): Int {
        val degrees = when (windowManager.defaultDisplay.rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
        return PreviewLayoutPolicy.displayOrientation(cameraInfo.orientation, degrees,
            cameraInfo.facing == Camera.CameraInfo.CAMERA_FACING_FRONT)
    }

    private fun updatePreviewGeometry() {
        val cam = camera ?: return
        val width = previewContainer.width - previewContainer.paddingLeft - previewContainer.paddingRight
        val height = previewContainer.height - previewContainer.paddingTop - previewContainer.paddingBottom
        if (width <= 0 || height <= 0 || previewWidth <= 0 || previewHeight <= 0) return
        val rotation = displayOrientation()
        if (rotation != cameraRotation) {
            try {
                cam.setDisplayOrientation(rotation)
                cameraRotation = rotation
            } catch (error: RuntimeException) {
                // Preview rotation can fail when the camera is interrupted; release rather than reuse it.
                finished = true
                releaseCamera()
                Toast.makeText(this, R.string.camera_unavailable, Toast.LENGTH_LONG).show()
                finish()
                return
            }
        }
        val frame = PreviewLayoutPolicy.previewFrame(width, height, previewWidth, previewHeight, rotation % 180 != 0)
        val layout = preview.layoutParams as FrameLayout.LayoutParams
        if (layout.gravity != Gravity.CENTER || layout.width != frame[2] || layout.height != frame[3]) {
            // Framework centering handles both crop axes identically in LTR and RTL locales.
            layout.gravity = Gravity.CENTER
            layout.width = frame[2]
            layout.height = frame[3]
            preview.layoutParams = layout
        }
        val topReserved = dp(80)
        val usableHeight = (height - topReserved - dp(96) - scanHint.measuredHeight).coerceAtLeast(1)
        val frameSize = minOf(dp(260), (width - dp(32)).coerceAtLeast(1), usableHeight)
        val scanLayout = scanFrame.layoutParams as FrameLayout.LayoutParams
        val topMargin = topReserved + (usableHeight - frameSize) / 2
        if (scanLayout.width != frameSize || scanLayout.height != frameSize || scanLayout.topMargin != topMargin) {
            scanLayout.width = frameSize
            scanLayout.height = frameSize
            scanLayout.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            scanLayout.topMargin = topMargin
            scanFrame.layoutParams = scanLayout
        }
    }

    private fun onPreviewFrame(data: ByteArray) {
        if (decoding || finished || camera == null) return
        decoding = true
        try {
            val text = QrDecoder.decodeNv21(data, previewWidth, previewHeight)
            if (text != null) {
                finished = true
                setResult(RESULT_OK, Intent().putExtra(EXTRA_QR_RESULT, text))
                finish()
            }
        } finally {
            decoding = false
        }
    }

    private fun releaseCamera() {
        val cam = camera
        camera = null
        cameraRotation = -1
        previewWidth = 0
        previewHeight = 0
        disableZoom()
        if (cam == null) return
        runCatching { cam.setPreviewCallback(null) }
        runCatching { cam.stopPreview() }
        runCatching { cam.release() }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_QR_RESULT = "qr_result"
    }
}
