package io.github.sayach.dshmobile

/** Launcher alias selection and exception-safe component updates without Android dependencies. */
internal object LauncherIconPolicy {
    data class Icon(val key: String, val alias: String)
    data class Change(val icon: Icon, val state: Int)

    val icons = listOf(
        Icon("whale_girl", "LauncherWhaleGirl"),
        Icon("mascot_classic", "LauncherMascotClassic"),
        Icon("mascot_cheer", "LauncherMascotCheer"),
        Icon("mascot_quiet", "LauncherMascotQuiet"),
        Icon("official_whale", "LauncherOfficialWhale"),
        Icon("official_whale_dark", "LauncherOfficialWhaleDark"),
        Icon("official_whale_teal", "LauncherOfficialWhaleTeal"),
        Icon("official_whale_mono", "LauncherOfficialWhaleMono"),
        Icon("official_whale_black", "LauncherOfficialWhaleBlack"),
        Icon("official_whale_white", "LauncherOfficialWhaleWhite"),
    )

    /** Alias class names belong to the Kotlin namespace, not a variant's application ID. */
    fun aliasClassName(namespace: String, icon: Icon): String = "$namespace.${icon.alias}"

    fun isEnabled(icon: Icon, state: Int): Boolean =
        state == STATE_ENABLED || state == STATE_DEFAULT && icon == icons.first()

    /** Chooses an enabled alias before trusting a preference written by an earlier app build. */
    fun selectedKey(preferred: String?, readState: (Icon) -> Int): String {
        val enabled = icons.filter { isEnabled(it, readState(it)) }
        return enabled.firstOrNull { it.key == preferred }?.key
            ?: enabled.firstOrNull()?.key
            ?: icons.first().key
    }

    /**
     * Enables a selected launcher alias before removing another on legacy Android.
     * Atomic updates receive the complete batch. Failures attempt to restore previous states;
     * if every old entry rejects restoration, the new fallback remains enabled.
     * The caller persists its preference only after this function returns.
     */
    fun switchIcon(
        key: String,
        atomic: Boolean,
        readState: (Icon) -> Int,
        update: (List<Change>) -> Unit,
    ) {
        val selected = requireNotNull(icons.firstOrNull { it.key == key })
        val before = icons.map { Change(it, readState(it)) }
        val next = listOf(Change(selected, STATE_ENABLED)) +
            icons.filter { it != selected }.map { Change(it, STATE_DISABLED) }
        try {
            if (atomic) update(next) else next.forEach { update(listOf(it)) }
        } catch (error: Exception) {
            val restore = before.sortedBy { if (isEnabled(it.icon, it.state)) 0 else 1 }
            if (atomic) {
                try {
                    update(restore)
                } catch (restoreError: Exception) {
                    error.addSuppressed(restoreError)
                }
            } else {
                val active = restore.filter { isEnabled(it.icon, it.state) }
                var entryRestored = false
                active.forEach { change ->
                    try {
                        update(listOf(change))
                        entryRestored = true
                    } catch (restoreError: Exception) {
                        error.addSuppressed(restoreError)
                    }
                }
                // Never disable the newly enabled fallback if every attempt to restore an old entry failed.
                if (entryRestored) {
                    restore.filterNot { isEnabled(it.icon, it.state) }.forEach { change ->
                        try {
                            update(listOf(change))
                        } catch (restoreError: Exception) {
                            error.addSuppressed(restoreError)
                        }
                    }
                }
            }
            throw error
        }
    }

    // Android's stable COMPONENT_ENABLED_STATE_* values; snapshots preserve other states too.
    const val STATE_DEFAULT = 0
    const val STATE_ENABLED = 1
    const val STATE_DISABLED = 2
}
