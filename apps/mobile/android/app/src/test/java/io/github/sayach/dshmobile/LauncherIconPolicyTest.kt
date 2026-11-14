package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Launcher switching keeps a resolvable entry throughout legacy updates and restores failures. */
class LauncherIconPolicyTest {
    @Test
    fun manifestDefaultsEnableOnlyTheMascot() {
        val enabled = LauncherIconPolicy.icons.filter {
            LauncherIconPolicy.isEnabled(it, LauncherIconPolicy.STATE_DEFAULT)
        }
        assertEquals(listOf(LauncherIconPolicy.icons.first()), enabled)
    }

    @Test
    fun everyLegacyTransitionEnablesTheTargetBeforeDisablingAnyAlias() {
        for (old in LauncherIconPolicy.icons) {
            for (next in LauncherIconPolicy.icons) {
                val states = LauncherIconPolicy.icons.associateWith {
                    if (it == old) LauncherIconPolicy.STATE_ENABLED else LauncherIconPolicy.STATE_DISABLED
                }.toMutableMap()
                val calls = mutableListOf<LauncherIconPolicy.Change>()
                LauncherIconPolicy.switchIcon(next.key, false, { states.getValue(it) }) { changes ->
                    assertEquals(1, changes.size)
                    states[changes.single().icon] = changes.single().state
                    calls += changes
                    assertTrue(states.any { LauncherIconPolicy.isEnabled(it.key, it.value) })
                }
                assertEquals(next, calls.first().icon)
                assertEquals(LauncherIconPolicy.STATE_ENABLED, calls.first().state)
                assertEquals(listOf(next), states.filter { LauncherIconPolicy.isEnabled(it.key, it.value) }.keys.toList())
            }
        }
    }

    @Test
    fun atomicSwitchUsesOneCompleteBatch() {
        val batches = mutableListOf<List<LauncherIconPolicy.Change>>()
        LauncherIconPolicy.switchIcon(LauncherIconPolicy.icons.last().key, true,
            { LauncherIconPolicy.STATE_DEFAULT }) { batches += it }
        assertEquals(1, batches.size)
        assertEquals(10, batches.single().size)
        assertEquals(1, batches.single().count { it.state == LauncherIconPolicy.STATE_ENABLED })
    }

    @Test
    fun failedLegacySwitchRestoresEveryExactStateBeforeRethrowing() {
        val states = LauncherIconPolicy.icons.associateWith { LauncherIconPolicy.STATE_DEFAULT }.toMutableMap()
        val before = states.toMap()
        var calls = 0
        val failure = IllegalStateException("simulated binder failure")
        try {
            LauncherIconPolicy.switchIcon(LauncherIconPolicy.icons.last().key, false, { states.getValue(it) }) { changes ->
                calls++
                if (calls == 3) throw failure
                changes.forEach { states[it.icon] = it.state }
                assertTrue(states.any { LauncherIconPolicy.isEnabled(it.key, it.value) })
            }
            throw AssertionError("component update should fail")
        } catch (error: IllegalStateException) {
            assertTrue(error === failure)
        }
        assertEquals(before, states)
        assertEquals(13, calls)
    }

    @Test
    fun failedAtomicSwitchRestoresTheSnapshotAsABatch() {
        val states = LauncherIconPolicy.icons.associateWith { LauncherIconPolicy.STATE_DEFAULT }.toMutableMap()
        var calls = 0
        try {
            LauncherIconPolicy.switchIcon(LauncherIconPolicy.icons.last().key, true, { states.getValue(it) }) { changes ->
                calls++
                if (calls == 1) throw IllegalStateException("atomic failure")
                changes.forEach { states[it.icon] = it.state }
            }
            throw AssertionError("component update should fail")
        } catch (_: IllegalStateException) {
            assertEquals(2, calls)
            assertTrue(states.values.all { it == LauncherIconPolicy.STATE_DEFAULT })
        }
    }

    @Test
    fun rollbackFailureKeepsTheNewFallbackLauncherEnabled() {
        var calls = 0
        val failure = IllegalStateException("original failure")
        val states = LauncherIconPolicy.icons.associateWith { LauncherIconPolicy.STATE_DEFAULT }.toMutableMap()
        try {
            LauncherIconPolicy.switchIcon(LauncherIconPolicy.icons.last().key, false,
                { states.getValue(it) }) { changes ->
                calls++
                if (calls == 3) throw failure
                if (calls == 4) throw IllegalStateException("rollback failure")
                changes.forEach { states[it.icon] = it.state }
            }
            throw AssertionError("component update should fail")
        } catch (error: IllegalStateException) {
            assertTrue(error === failure)
            assertEquals(1, error.suppressed.size)
            assertEquals(4, calls)
            assertTrue(LauncherIconPolicy.isEnabled(LauncherIconPolicy.icons.last(), states.getValue(LauncherIconPolicy.icons.last())))
        }
    }

    @Test
    fun invalidSelectionDoesNotUpdateAnyComponent() {
        var changed = false
        try {
            LauncherIconPolicy.switchIcon("removed-choice", false, { LauncherIconPolicy.STATE_DEFAULT }) { changed = true }
            throw AssertionError("unknown icon should be rejected")
        } catch (_: IllegalArgumentException) {
            assertFalse(changed)
        }
    }

    @Test
    fun actualComponentStatesTakePriorityOverStalePreferences() {
        val enabled = LauncherIconPolicy.icons[3]
        val selected = LauncherIconPolicy.selectedKey(LauncherIconPolicy.icons[1].key) {
            if (it == enabled) LauncherIconPolicy.STATE_ENABLED else LauncherIconPolicy.STATE_DISABLED
        }
        assertEquals(enabled.key, selected)
        assertEquals(LauncherIconPolicy.icons.first().key,
            LauncherIconPolicy.selectedKey("unknown") { LauncherIconPolicy.STATE_DEFAULT })
    }

    @Test
    fun independentApplicationIdsKeepAliasNamesInTheCodeNamespace() {
        assertEquals("io.github.sayach.dshmobile.LauncherWhaleGirl",
            LauncherIconPolicy.aliasClassName("io.github.sayach.dshmobile", LauncherIconPolicy.icons.first()))
    }
}
