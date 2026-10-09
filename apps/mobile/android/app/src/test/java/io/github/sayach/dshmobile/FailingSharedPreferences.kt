package io.github.sayach.dshmobile

import android.content.SharedPreferences

/** Models Android's live-memory update before a disk commit fails or throws. */
internal class FailingSharedPreferences(initial: Map<String, Any> = emptyMap()) : SharedPreferences {
    enum class CommitOutcome { SUCCESS, FALSE, THROW }

    val values = initial.toMutableMap()
    var persisted = initial.toMap()
        private set
    val commitOutcomes = ArrayDeque<CommitOutcome>()
    var commits = 0
        private set

    override fun getAll(): MutableMap<String, *> = values.toMutableMap()
    override fun contains(key: String): Boolean = values.containsKey(key)
    override fun getString(key: String, defValue: String?): String? = typedValue<String>(key) ?: defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean = typedValue<Boolean>(key) ?: defValue
    override fun getInt(key: String, defValue: Int): Int = typedValue<Int>(key) ?: defValue
    override fun getLong(key: String, defValue: Long): Long = typedValue<Long>(key) ?: defValue
    override fun getFloat(key: String, defValue: Float): Float = typedValue<Float>(key) ?: defValue
    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? {
        val value = typedValue<Set<*>>(key) ?: return defValues
        if (value.any { it !is String }) throw ClassCastException(key)
        return value.filterIsInstance<String>().toMutableSet()
    }

    private inline fun <reified T> typedValue(key: String): T? {
        val value = values[key] ?: return null
        return value as? T ?: throw ClassCastException(key)
    }

    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
    override fun edit(): SharedPreferences.Editor = Editor()

    private inner class Editor : SharedPreferences.Editor {
        private val pending = linkedMapOf<String, Any?>()
        private var clearRequested = false

        override fun putString(key: String, value: String?): SharedPreferences.Editor = put(key, value)
        override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = put(key, value)
        override fun putInt(key: String, value: Int): SharedPreferences.Editor = put(key, value)
        override fun putLong(key: String, value: Long): SharedPreferences.Editor = put(key, value)
        override fun putFloat(key: String, value: Float): SharedPreferences.Editor = put(key, value)
        override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = put(key, values?.toSet())
        override fun remove(key: String): SharedPreferences.Editor = put(key, null)
        override fun clear(): SharedPreferences.Editor = apply { clearRequested = true }

        private fun put(key: String, value: Any?): SharedPreferences.Editor = apply { pending[key] = value }

        override fun commit(): Boolean {
            commits++
            if (clearRequested) values.clear()
            pending.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
            return when (commitOutcomes.removeFirstOrNull() ?: CommitOutcome.SUCCESS) {
                CommitOutcome.SUCCESS -> true.also { persisted = values.toMap() }
                CommitOutcome.FALSE -> false
                CommitOutcome.THROW -> throw IllegalStateException("injected disk failure")
            }
        }

        override fun apply() { error("Credential writes must observe commit results") }
    }
}
