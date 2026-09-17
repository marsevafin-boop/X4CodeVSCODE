package ru.marse.agenthub

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * Тонкая обёртка: открывает мобильный клиент Agent Hub (страницу, которую
 * отдаёт расширение VS Code на компьютере). Адрес приходит из QR-кода
 * (agenthub://host:port/t/<token>/) или вводится вручную и запоминается.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val prefs by lazy { getSharedPreferences("agenthub", MODE_PRIVATE) }

    private val chooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            fileCallback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data),
            )
            fileCallback = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            setSupportZoom(false)
        }
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (request.isForMainFrame) {
                    showSetup(getString(R.string.error_load, error.description))
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    chooser.launch(params.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }
        setContentView(web)

        val fromIntent = intent?.data?.let { toHttp(it) }
        if (fromIntent != null) prefs.edit().putString("url", fromIntent).apply()
        val url = fromIntent ?: prefs.getString("url", null)
        if (url.isNullOrBlank()) showSetup(null) else web.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { toHttp(it) }?.let {
            prefs.edit().putString("url", it).apply()
            web.loadUrl(it)
        }
    }

    /** agenthub://… → http://…, agenthubs://… → https://…; http(s) — как есть. */
    private fun toHttp(u: Uri): String? = when (u.scheme) {
        "agenthub" -> "http://" + u.toString().removePrefix("agenthub://")
        "agenthubs" -> "https://" + u.toString().removePrefix("agenthubs://")
        "http", "https" -> u.toString()
        else -> null
    }

    private fun showSetup(message: String?) {
        val input = EditText(this).apply {
            hint = getString(R.string.url_hint)
            setText(prefs.getString("url", "") ?: "")
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.setup_title)
            .setMessage(message ?: getString(R.string.setup_message))
            .setView(input)
            .setPositiveButton(R.string.connect) { _, _ ->
                val v = input.text.toString().trim()
                if (v.isNotEmpty()) {
                    val url = toHttp(Uri.parse(v)) ?: v
                    prefs.edit().putString("url", url).apply()
                    web.loadUrl(url)
                }
            }
            .setNegativeButton(R.string.retry) { _, _ ->
                prefs.getString("url", null)?.let { web.loadUrl(it) }
            }
            .setCancelable(false)
            .show()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) {
            web.goBack()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.app_name)
            .setItems(arrayOf(getString(R.string.change_server), getString(R.string.exit))) { _, i ->
                if (i == 0) showSetup(null) else finish()
            }
            .show()
    }
}
