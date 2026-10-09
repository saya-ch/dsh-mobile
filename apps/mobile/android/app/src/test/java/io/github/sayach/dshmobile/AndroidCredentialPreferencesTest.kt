package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidCredentialPreferencesTest {
    @Test
    fun failedDiskCommitsRestoreOnlyTouchedLiveValuesIncludingAbsentKeys() {
        for (failure in listOf(FailingSharedPreferences.CommitOutcome.FALSE, FailingSharedPreferences.CommitOutcome.THROW)) {
            val original = mapOf<String, Any>("payload" to "saved", "iv" to "saved-iv", "legacy_migrated" to false, "unrelated" to 9L)
            val preferences = FailingSharedPreferences(original)
            val adapter = AndroidCredentialPreferences(preferences)
            preferences.commitOutcomes.add(failure)
            assertThrows(CredentialStorageUnavailable::class.java) {
                adapter.write(mapOf("payload" to "replacement", "iv" to "new-iv", "new-key" to "new"), mapOf("legacy_migrated" to true))
            }
            assertEquals(original, preferences.values)
            assertEquals(original, preferences.persisted)
            assertEquals(2, preferences.commits)
        }
    }

    @Test
    fun failedClearRestoresEverySupportedPreferenceTypeBeforeReturningTheError() {
        val original = mapOf<String, Any>("string" to "saved", "boolean" to true, "int" to 4, "long" to 8L,
            "float" to 1.5f, "set" to setOf("one", "two"))
        for (failure in listOf(FailingSharedPreferences.CommitOutcome.FALSE, FailingSharedPreferences.CommitOutcome.THROW)) {
            val preferences = FailingSharedPreferences(original)
            preferences.commitOutcomes.add(failure)
            assertThrows(CredentialStorageUnavailable::class.java) { AndroidCredentialPreferences(preferences).clear() }
            assertEquals(original, preferences.values)
            assertEquals(original, preferences.persisted)
        }
    }

    @Test
    fun aFailedRollbackDiskCommitStillRestoresThePriorLiveValuesAndReportsFailure() {
        val original = mapOf<String, Any>("payload" to "saved", "iv" to "saved-iv")
        val preferences = FailingSharedPreferences(original)
        preferences.commitOutcomes.addAll(listOf(FailingSharedPreferences.CommitOutcome.FALSE, FailingSharedPreferences.CommitOutcome.FALSE))
        assertThrows(CredentialStorageUnavailable::class.java) {
            AndroidCredentialPreferences(preferences).write(mapOf("payload" to "replacement", "iv" to "replacement-iv"))
        }
        assertEquals(original, preferences.values)
        assertEquals(original, preferences.persisted)
    }
}
