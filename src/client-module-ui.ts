/** Device-local module selection and the computer's defaults share a read-only catalog. */
import { createElement, type ReactElement } from 'react'
import { localAdminRequestHeaders } from './local-admin-host.js'
import type { MobileControlLocale } from './client-messages.js'
import { ClientModuleDraft, clientModuleDisplayName, clientModuleGroup, clientModuleMinimalImpact, formatClientModuleSize, sortClientModulesBySize, type ClientModuleFilter, type ClientModuleGroup, type ClientModuleRow } from './client-module-presentation.js'

export type { ClientModuleRow } from './client-module-presentation.js'

export const CLIENT_MODULE_COPY = {
  zh: {
    measure: '测量体积', measuring: '正在测量…', cancelMeasure: '取消测量', measured: '测量结束，未测到的项目保持未知。你的模块选择未变。', measureFailed: '测量未完成，已保留模块选择和已有体积。', totalPartial: '已测合计约 {size}；另有 {count} 项未知',
    title: '移动页面模块', computer: '设置此电脑的移动访问默认项；电脑插件不变。', device: '仅本设备，下次打开生效；电脑插件不变。', open: '管理', help: '加载规则',
    loading: '正在读取模块…', hint: '勾选表示下次打开时加载。启动必需项受保护；依赖冲突会在保存时说明，不会自动取消其他模块。',
    save: '保存选择', reset: '恢复默认', close: '关闭', required: '启动必需', dependencies: '依赖：', noDependencies: '无声明的前端依赖', details: '模块详情', moduleId: '模块 ID',
    saved: '已保存，下次打开 DSH 生效。不会自动刷新当前页面或丢弃草稿。', failed: '暂时无法读取模块。请确认移动访问已启用后重试。', saveFailed: '未确认保存成功，已保留你的选择。可重新保存，或重新读取已保存设置。',
    conflict: '无法保存：', catalogChanged: '模块目录已变化（插件或版本有更新），本次保存已取消。请点「重新读取」，确认后再保存。', computerSource: '当前来源：电脑默认设置', deviceSource: '当前来源：本设备设置', pluginSource: '当前来源：插件默认设置',
    resetConfirm: '恢复默认模块选择？仅下次打开生效，不会重新加载当前会话。', discardConfirm: '放弃未保存的模块选择并关闭？', reloadConfirm: '重新读取会替换未保存的选择。继续吗？', savingCloseConfirm: '保存结果尚未确认。现在关闭不会撤销可能已完成的保存，确定关闭吗？',
    search: '搜索模块', searchPlaceholder: '搜索名称或模块 ID', filter: '加载选择', all: '全部', loaded: '加载', excluded: '不加载', empty: '没有符合条件的模块。', clearFilters: '清除筛选',
    extensions: '可选扩展', extensionsHint: '可选择不加载的前端模块；一项模块不一定等于一个完整插件。', advanced: 'DSH 可选组件（高级）', advancedHint: 'DSH 的可选前端组件。只修改你了解的项目。', requiredGroup: '启动必需项', requiredHint: '这些模块保证页面启动，不能关闭。',
    changes: '未保存：{count} 项改动', unchanged: '没有未保存的改动', results: '匹配 {visible} / {total} 项', sizeHint: '按传输体积从大到小排列；数字为 gzip 后的字节。说明取自插件包自身的描述字段，不代表上游认证。', total: '勾选合计约 {size}', totalUnknown: '勾选合计：部分模块未测到体积', minimal: '仅必需（最小加载）', minimalConfirm: '把除了启动必需项及其依赖之外全部设为不加载？保存后下次打开生效。', minimalDetail: '将排除 {count} 个可选模块；已测 gzip 合计 {size}，另有 {unknown} 项体积未知。启动必需项及其依赖会保留。', retry: '重新读取', saving: '正在保存…', readTimeout: '读取超时。当前页面和已保存设置未变，请重试。', writeTimeout: '保存超时，结果尚未确认。保留了你的选择；请重新读取确认，不会自动重试保存。', nextOpen: '仅下次打开生效',
    invalidSelections: '失效的旧选择', invalidHint: '这些旧排除已与当前模块目录不符。移除后仍需保存选择。', invalidMissing: '当前模块目录中不存在。', invalidRequired: '当前已是启动必需项，不能排除。', clearInvalid: '移除旧排除',
  },
  en: {
    measure: 'Measure sizes', measuring: 'Measuring…', cancelMeasure: 'Cancel measurement', measured: 'Measurement ended; unavailable sizes stay unknown. Your module choices are unchanged.', measureFailed: 'Measurement did not complete. Your choices and known sizes are kept.', totalPartial: 'Measured ≈ {size}; {count} sizes unknown',
    title: 'Mobile page modules', computer: 'Mobile defaults for this computer. Desktop plugins are unchanged.', device: 'For this device’s next open only. Computer plugins are unchanged.', open: 'Manage', help: 'Loading rules',
    loading: 'Reading modules…', hint: 'Checked means load on the next open. Required entries are protected; saving explains dependency conflicts without unchecking other modules.',
    save: 'Save selection', reset: 'Restore defaults', close: 'Close', required: 'Required for boot', dependencies: 'Depends on: ', noDependencies: 'No declared frontend dependencies', details: 'Module details', moduleId: 'Module ID',
    saved: 'Saved for the next DSH open. This page is not refreshed and its draft is kept.', failed: 'Could not read modules. Enable mobile access and try again.', saveFailed: 'Saving was not confirmed. Your choices are kept. Save again or reread the saved settings.',
    conflict: 'Could not save: ', catalogChanged: 'The module catalog changed (a plugin or version update). This save was cancelled; reread the settings, then confirm again.', computerSource: 'Source: computer defaults', deviceSource: 'Source: this device’s settings', pluginSource: 'Source: plugin defaults',
    resetConfirm: 'Restore default selections for the next open? The current conversation will not reload.', discardConfirm: 'Discard unsaved module choices and close?', reloadConfirm: 'Rereading replaces unsaved choices. Continue?', savingCloseConfirm: 'Saving is not confirmed. Closing will not undo a save that may have completed. Close anyway?',
    search: 'Search modules', searchPlaceholder: 'Search name or module ID', filter: 'Loading selection', all: 'All', loaded: 'Load', excluded: 'Do not load', empty: 'No modules match these filters.', clearFilters: 'Clear filters',
    extensions: 'Optional extensions', extensionsHint: 'Optional frontend modules; one module is not necessarily a complete plugin.', advanced: 'DSH optional components (advanced)', advancedHint: 'Optional DSH frontend components. Change only entries you understand.', requiredGroup: 'Required for boot', requiredHint: 'These modules keep the page bootable and cannot be disabled.',
    changes: 'Unsaved: {count} changes', unchanged: 'No unsaved changes', results: 'Matching {visible} / {total}', sizeHint: 'Sorted by transfer size; numbers are gzipped bytes. Descriptions come from each plugin package; this is not an upstream endorsement.', total: 'Selection ≈ {size}', totalUnknown: 'Selection total: some sizes are unknown', minimal: 'Required only (minimal load)', minimalConfirm: 'Mark everything except required modules and their dependencies as not loaded? Applies on the next open after saving.', minimalDetail: 'This excludes {count} optional modules; measured gzip total: {size}; {unknown} remain unmeasured. Required modules and their dependencies stay loaded.', retry: 'Reread settings', saving: 'Saving…', readTimeout: 'Reading timed out. This page and saved settings are unchanged; try again.', writeTimeout: 'Saving timed out and its result is unconfirmed. Your choices are kept. Reread to confirm; saving is not retried automatically.', nextOpen: 'Applies on next open only',
    invalidSelections: 'Outdated selections', invalidHint: 'These old exclusions no longer match the module catalog. Save your choices after removing them.', invalidMissing: 'Not present in the current module catalog.', invalidRequired: 'Now required for boot and cannot be excluded.', clearInvalid: 'Remove old exclusion',
  },
  it: {
    measure: 'Misura dimensioni', measuring: 'Misurazione…', cancelMeasure: 'Annulla misurazione', measured: 'Misurazione terminata; le dimensioni non disponibili restano sconosciute. Le scelte non cambiano.', measureFailed: 'Misurazione incompleta. Scelte e dimensioni note conservate.', totalPartial: 'Misurati ≈ {size}; {count} dimensioni sconosciute',
    title: 'Moduli della pagina mobile', computer: 'Predefiniti mobile del computer; i plugin non cambiano.', device: 'Solo alla prossima apertura su questo dispositivo; i plugin del computer non cambiano.', open: 'Gestisci', help: 'Regole di caricamento',
    loading: 'Lettura dei moduli…', hint: 'Selezionato significa caricare alla prossima apertura. I moduli obbligatori sono protetti; il salvataggio mostra i conflitti senza deselezionare altri moduli.',
    save: 'Salva selezione', reset: 'Ripristina predefiniti', close: 'Chiudi', required: 'Obbligatorio', dependencies: 'Dipende da: ', noDependencies: 'Nessuna dipendenza frontend dichiarata', details: 'Dettagli modulo', moduleId: 'ID modulo',
    saved: 'Salvato per la prossima apertura di DSH. La pagina non si aggiorna e la bozza resta.', failed: 'Impossibile leggere i moduli. Abilita accesso mobile e riprova.', saveFailed: 'Salvataggio non confermato. Le scelte restano; salva di nuovo o rileggi le impostazioni salvate.',
    conflict: 'Impossibile salvare: ', catalogChanged: 'Il catalogo dei moduli è cambiato (aggiornamento di plugin o versione). Salvataggio annullato: rileggi le impostazioni e conferma di nuovo.', computerSource: 'Origine: predefiniti del computer', deviceSource: 'Origine: impostazioni del dispositivo', pluginSource: 'Origine: predefiniti del plugin',
    resetConfirm: 'Ripristinare i predefiniti per la prossima apertura? La conversazione attuale non verrà ricaricata.', discardConfirm: 'Scartare le scelte non salvate e chiudere?', reloadConfirm: 'Rileggere sostituisce le scelte non salvate. Continuare?', savingCloseConfirm: 'Salvataggio non confermato. Chiudere non annulla un salvataggio già completato. Chiudere comunque?',
    search: 'Cerca moduli', searchPlaceholder: 'Cerca nome o ID modulo', filter: 'Selezione caricamento', all: 'Tutti', loaded: 'Carica', excluded: 'Non caricare', empty: 'Nessun modulo corrisponde ai filtri.', clearFilters: 'Cancella filtri',
    extensions: 'Estensioni facoltative', extensionsHint: 'Moduli frontend facoltativi; un modulo non è necessariamente un plugin completo.', advanced: 'Componenti DSH facoltativi (avanzate)', advancedHint: 'Componenti frontend DSH facoltativi. Modifica solo quelli che conosci.', requiredGroup: 'Moduli obbligatori', requiredHint: 'Questi moduli permettono l’avvio e non possono essere disattivati.',
    changes: 'Non salvate: {count} modifiche', unchanged: 'Nessuna modifica non salvata', results: 'Corrispondenti {visible} / {total}', sizeHint: 'Ordinati per dimensione trasferita; i numeri sono byte gzip. Le descrizioni provengono dal pacchetto del plugin; non sono un’approvazione upstream.', total: 'Selezione ≈ {size}', totalUnknown: 'Totale selezione: alcune dimensioni sono sconosciute', minimal: 'Solo obbligatori (caricamento minimo)', minimalConfirm: 'Impostare come non caricati tutti i moduli tranne gli obbligatori e le loro dipendenze? Vale alla prossima apertura dopo il salvataggio.', minimalDetail: 'Verranno esclusi {count} moduli facoltativi; totale gzip misurato: {size}; {unknown} non misurati. Gli obbligatori e le loro dipendenze restano caricati.', retry: 'Rileggi impostazioni', saving: 'Salvataggio…', readTimeout: 'Lettura scaduta. Pagina e impostazioni salvate non cambiano; riprova.', writeTimeout: 'Salvataggio scaduto e non confermato. Le scelte restano. Rileggi per confermare; nessun tentativo automatico.', nextOpen: 'Solo alla prossima apertura',
    invalidSelections: 'Scelte obsolete', invalidHint: 'Queste esclusioni precedenti non corrispondono più al catalogo. Salva le scelte dopo averle rimosse.', invalidMissing: 'Assente dal catalogo attuale dei moduli.', invalidRequired: 'Ora obbligatorio per l’avvio e non può essere escluso.', clearInvalid: 'Rimuovi esclusione precedente',
  },
  ja: {
    measure: 'サイズを測定', measuring: '測定中…', cancelMeasure: '測定を中止', measured: '測定が終了しました。測定できなかった項目は不明のままです。モジュールの選択は変更されていません。', measureFailed: '測定は完了しませんでした。選択と判明済みのサイズは保持されています。', totalPartial: '測定済み 約 {size}、{count} 項目は不明',
    title: 'モバイルページのモジュール', computer: 'このコンピューターのモバイル用既定設定です。コンピューターのプラグインは変更されません。', device: 'このデバイスの次回起動にのみ適用されます。コンピューターのプラグインは変更されません。', open: '管理', help: '読み込みルール',
    loading: 'モジュールを読み込んでいます…', hint: 'チェックを入れると次回起動時に読み込みます。起動に必要な項目は保護されています。依存関係の競合は保存時に説明され、他のモジュールが自動的に外れることはありません。',
    save: '選択を保存', reset: '既定に戻す', close: '閉じる', required: '起動に必須', dependencies: '依存先: ', noDependencies: '宣言されたフロントエンド依存関係はありません', details: 'モジュールの詳細', moduleId: 'モジュール ID',
    saved: '次回の DSH 起動用に保存しました。このページは更新されず、下書きは保持されます。', failed: 'モジュールを読み込めませんでした。モバイルアクセスを有効にして再試行してください。', saveFailed: '保存は確認されていません。選択は保持されています。もう一度保存するか、保存済みの設定を読み直してください。',
    conflict: '保存できません: ', catalogChanged: 'モジュールカタログが変更されました（プラグインまたはバージョンの更新）。今回の保存は中止されました。設定を読み直してから、もう一度確定してください。', computerSource: '現在の取得元: コンピューターの既定設定', deviceSource: '現在の取得元: このデバイスの設定', pluginSource: '現在の取得元: プラグインの既定設定',
    resetConfirm: '既定の選択に戻しますか？次回起動時にのみ適用され、現在の会話は再読み込みされません。', discardConfirm: '未保存のモジュール選択を破棄して閉じますか？', reloadConfirm: '読み直すと未保存の選択が置き換わります。続行しますか？', savingCloseConfirm: '保存結果はまだ確認されていません。今閉じても、完了した可能性のある保存は取り消されません。閉じますか？',
    search: 'モジュールを検索', searchPlaceholder: '名前またはモジュール ID で検索', filter: '読み込みの選択', all: 'すべて', loaded: '読み込む', excluded: '読み込まない', empty: '条件に一致するモジュールはありません。', clearFilters: '絞り込みを解除',
    extensions: '任意の拡張機能', extensionsHint: '任意のフロントエンドモジュールです。1 つのモジュールが 1 つの完全なプラグインとは限りません。', advanced: 'DSH の任意コンポーネント（上級者向け）', advancedHint: 'DSH の任意のフロントエンドコンポーネントです。理解している項目だけを変更してください。', requiredGroup: '起動に必須の項目', requiredHint: 'これらのモジュールはページの起動を保証するもので、無効にはできません。',
    changes: '未保存: {count} 件の変更', unchanged: '未保存の変更はありません', results: '一致 {visible} / {total} 件', sizeHint: '転送サイズの大きい順に並んでいます。数値は gzip 後のバイト数です。説明は各プラグインパッケージの説明から取得したもので、上流による承認を意味しません。', total: '選択合計 約 {size}', totalUnknown: '選択合計: 一部のサイズは不明です', minimal: '必須のみ（最小読み込み）', minimalConfirm: '起動に必須のモジュールとその依存関係を除き、すべてを読み込まない設定にしますか？保存後、次回起動時から適用されます。', minimalDetail: '{count} 個の任意モジュールを除外します。測定済み gzip 合計: {size}、{unknown} 項目は未測定です。起動に必須のモジュールとその依存関係は読み込まれます。', retry: '設定を読み直す', saving: '保存しています…', readTimeout: '読み込みがタイムアウトしました。このページと保存済みの設定は変更されていません。再試行してください。', writeTimeout: '保存がタイムアウトし、結果は確認されていません。選択は保持されています。確認のため読み直してください。保存は自動で再試行されません。', nextOpen: '次回起動時のみ適用',
    invalidSelections: '無効になった古い選択', invalidHint: 'これらの古い除外設定は現在のモジュールカタログと一致しません。削除した後も選択の保存が必要です。', invalidMissing: '現在のモジュールカタログに存在しません。', invalidRequired: '現在は起動に必須のため、除外できません。', clearInvalid: '古い除外を削除',
  },
  ko: {
    measure: '크기 측정', measuring: '측정 중…', cancelMeasure: '측정 취소', measured: '측정이 끝났습니다. 측정하지 못한 항목은 알 수 없는 상태로 남습니다. 모듈 선택은 변경되지 않았습니다.', measureFailed: '측정이 완료되지 않았습니다. 선택과 확인된 크기는 유지됩니다.', totalPartial: '측정 합계 약 {size}, 알 수 없는 항목 {count}개',
    title: '모바일 페이지 모듈', computer: '이 컴퓨터의 모바일 기본 설정입니다. 컴퓨터의 플러그인은 변경되지 않습니다.', device: '이 기기의 다음 열기에만 적용됩니다. 컴퓨터의 플러그인은 변경되지 않습니다.', open: '관리', help: '로드 규칙',
    loading: '모듈을 읽는 중…', hint: '체크하면 다음에 열 때 불러옵니다. 시작에 필요한 항목은 보호되며, 종속성 충돌은 저장할 때 설명되고 다른 모듈이 자동으로 해제되지 않습니다.',
    save: '선택 저장', reset: '기본값으로 복원', close: '닫기', required: '시작 필수', dependencies: '종속 대상: ', noDependencies: '선언된 프런트엔드 종속성 없음', details: '모듈 세부 정보', moduleId: '모듈 ID',
    saved: '다음 DSH 열기에 적용되도록 저장했습니다. 이 페이지는 새로 고쳐지지 않고 초안은 유지됩니다.', failed: '모듈을 읽을 수 없습니다. 모바일 액세스를 활성화한 후 다시 시도하십시오.', saveFailed: '저장이 확인되지 않았습니다. 선택은 유지됩니다. 다시 저장하거나 저장된 설정을 다시 읽으십시오.',
    conflict: '저장할 수 없습니다: ', catalogChanged: '모듈 카탈로그가 변경되었습니다(플러그인 또는 버전 업데이트). 이번 저장은 취소되었습니다. 설정을 다시 읽은 후 다시 확인하십시오.', computerSource: '현재 출처: 컴퓨터 기본 설정', deviceSource: '현재 출처: 이 기기 설정', pluginSource: '현재 출처: 플러그인 기본 설정',
    resetConfirm: '다음 열기에 적용할 기본 선택으로 복원하시겠습니까? 현재 대화는 다시 로드되지 않습니다.', discardConfirm: '저장하지 않은 모듈 선택을 버리고 닫으시겠습니까?', reloadConfirm: '다시 읽으면 저장하지 않은 선택이 대체됩니다. 계속하시겠습니까?', savingCloseConfirm: '저장 결과가 아직 확인되지 않았습니다. 지금 닫아도 이미 완료되었을 수 있는 저장은 취소되지 않습니다. 닫으시겠습니까?',
    search: '모듈 검색', searchPlaceholder: '이름 또는 모듈 ID 검색', filter: '로드 선택', all: '전체', loaded: '불러오기', excluded: '불러오지 않음', empty: '조건에 맞는 모듈이 없습니다.', clearFilters: '필터 지우기',
    extensions: '선택적 확장 요소', extensionsHint: '선택적 프런트엔드 모듈입니다. 모듈 하나가 반드시 완전한 플러그인인 것은 아닙니다.', advanced: 'DSH 선택적 구성 요소(고급)', advancedHint: 'DSH의 선택적 프런트엔드 구성 요소입니다. 이해하는 항목만 변경하십시오.', requiredGroup: '시작 필수 항목', requiredHint: '이 모듈은 페이지의 시작을 보장하며 비활성화할 수 없습니다.',
    changes: '저장 안 됨: {count}개 변경', unchanged: '저장하지 않은 변경 없음', results: '일치 {visible} / {total}개', sizeHint: '전송 크기가 큰 순서로 정렬되어 있으며 숫자는 gzip 후 바이트입니다. 설명은 각 플러그인 패키지의 설명 필드에서 가져온 것으로, 업스트림 인증을 의미하지 않습니다.', total: '선택 합계 약 {size}', totalUnknown: '선택 합계: 일부 크기를 알 수 없음', minimal: '필수만(최소 로드)', minimalConfirm: '시작 필수 모듈과 그 종속성을 제외한 모든 모듈을 불러오지 않도록 설정하시겠습니까? 저장 후 다음 열기부터 적용됩니다.', minimalDetail: '선택적 모듈 {count}개를 제외합니다. 측정된 gzip 합계: {size}, {unknown}개 항목은 미측정입니다. 시작 필수 모듈과 그 종속성은 유지됩니다.', retry: '설정 다시 읽기', saving: '저장 중…', readTimeout: '읽기 시간이 초과되었습니다. 현재 페이지와 저장된 설정은 변경되지 않았습니다. 다시 시도하십시오.', writeTimeout: '저장 시간이 초과되어 결과가 확인되지 않았습니다. 선택은 유지됩니다. 확인하려면 다시 읽으십시오. 저장은 자동으로 재시도되지 않습니다.', nextOpen: '다음 열기에만 적용',
    invalidSelections: '무효가 된 이전 선택', invalidHint: '이 이전 제외 항목은 현재 모듈 카탈로그와 일치하지 않습니다. 제거한 후에도 선택을 저장해야 합니다.', invalidMissing: '현재 모듈 카탈로그에 없습니다.', invalidRequired: '현재 시작 필수 항목이므로 제외할 수 없습니다.', clearInvalid: '이전 제외 제거',
  },
  es: {
    measure: 'Medir tamaños', measuring: 'Midiendo…', cancelMeasure: 'Cancelar medición', measured: 'La medición terminó; los tamaños no disponibles siguen sin conocerse. Tus elecciones de módulos no cambiaron.', measureFailed: 'La medición no se completó. Se conservan tus elecciones y los tamaños conocidos.', totalPartial: 'Medido ≈ {size}; {count} tamaños sin conocer',
    title: 'Módulos de la página móvil', computer: 'Valores predeterminados móviles de esta computadora. Los plugins de la computadora no cambian.', device: 'Solo para la próxima apertura en este dispositivo. Los plugins de la computadora no cambian.', open: 'Administrar', help: 'Reglas de carga',
    loading: 'Leyendo módulos…', hint: 'Marcado significa cargar en la próxima apertura. Las entradas necesarias para el inicio están protegidas; al guardar se explican los conflictos de dependencias sin desmarcar otros módulos.',
    save: 'Guardar selección', reset: 'Restaurar valores predeterminados', close: 'Cerrar', required: 'Necesario para iniciar', dependencies: 'Depende de: ', noDependencies: 'Sin dependencias de frontend declaradas', details: 'Detalles del módulo', moduleId: 'ID del módulo',
    saved: 'Guardado para la próxima apertura de DSH. Esta página no se actualiza y el borrador se conserva.', failed: 'No se pudieron leer los módulos. Habilita el acceso móvil y vuelve a intentarlo.', saveFailed: 'No se confirmó el guardado. Tus elecciones se conservan. Guarda de nuevo o vuelve a leer los ajustes guardados.',
    conflict: 'No se pudo guardar: ', catalogChanged: 'El catálogo de módulos cambió (actualización de un plugin o de la versión). Este guardado se canceló; vuelve a leer los ajustes y confirma otra vez.', computerSource: 'Origen: valores predeterminados de la computadora', deviceSource: 'Origen: ajustes de este dispositivo', pluginSource: 'Origen: valores predeterminados del plugin',
    resetConfirm: '¿Restaurar las selecciones predeterminadas para la próxima apertura? La conversación actual no se recargará.', discardConfirm: '¿Descartar las elecciones de módulos sin guardar y cerrar?', reloadConfirm: 'Volver a leer reemplaza las elecciones sin guardar. ¿Continuar?', savingCloseConfirm: 'El guardado no está confirmado. Cerrar no deshace un guardado que pueda haberse completado. ¿Cerrar de todos modos?',
    search: 'Buscar módulos', searchPlaceholder: 'Buscar nombre o ID del módulo', filter: 'Selección de carga', all: 'Todos', loaded: 'Cargar', excluded: 'No cargar', empty: 'Ningún módulo coincide con estos filtros.', clearFilters: 'Borrar filtros',
    extensions: 'Extensiones opcionales', extensionsHint: 'Módulos de frontend opcionales; un módulo no es necesariamente un plugin completo.', advanced: 'Componentes opcionales de DSH (avanzado)', advancedHint: 'Componentes de frontend opcionales de DSH. Cambia solo las entradas que entiendas.', requiredGroup: 'Necesarios para iniciar', requiredHint: 'Estos módulos mantienen la página en condiciones de iniciar y no se pueden desactivar.',
    changes: 'Sin guardar: {count} cambios', unchanged: 'Sin cambios sin guardar', results: 'Coincidencias {visible} / {total}', sizeHint: 'Ordenados por tamaño de transferencia; los números son bytes gzip. Las descripciones provienen del paquete de cada plugin; no constituyen una aprobación del origen.', total: 'Selección ≈ {size}', totalUnknown: 'Total de la selección: algunos tamaños no se conocen', minimal: 'Solo necesarios (carga mínima)', minimalConfirm: '¿Marcar como no cargados todos los módulos excepto los necesarios para iniciar y sus dependencias? Se aplica en la próxima apertura después de guardar.', minimalDetail: 'Esto excluye {count} módulos opcionales; total gzip medido: {size}; {unknown} sin medir. Los módulos necesarios y sus dependencias permanecen cargados.', retry: 'Volver a leer ajustes', saving: 'Guardando…', readTimeout: 'La lectura agotó el tiempo de espera. Esta página y los ajustes guardados no cambiaron; vuelve a intentarlo.', writeTimeout: 'El guardado agotó el tiempo de espera y su resultado no está confirmado. Tus elecciones se conservan. Vuelve a leer para confirmar; el guardado no se reintenta automáticamente.', nextOpen: 'Se aplica solo en la próxima apertura',
    invalidSelections: 'Selecciones obsoletas', invalidHint: 'Estas exclusiones antiguas ya no coinciden con el catálogo de módulos. Guarda tus elecciones después de quitarlas.', invalidMissing: 'No existe en el catálogo actual de módulos.', invalidRequired: 'Ahora es necesario para iniciar y no se puede excluir.', clearInvalid: 'Quitar exclusión antigua',
  },
  fr: {
    measure: 'Mesurer la taille', measuring: 'Mesure en cours…', cancelMeasure: 'Annuler la mesure', measured: 'La mesure est terminée ; les tailles indisponibles restent inconnues. Vos choix de modules ne sont pas modifiés.', measureFailed: 'La mesure n’est pas terminée. Vos choix et les tailles connues sont conservés.', totalPartial: 'Mesuré ≈ {size} ; {count} tailles inconnues',
    title: 'Modules de la page mobile', computer: 'Valeurs par défaut mobiles de cet ordinateur. Les plugins de l’ordinateur ne changent pas.', device: 'Uniquement pour la prochaine ouverture sur cet appareil. Les plugins de l’ordinateur ne changent pas.', open: 'Gérer', help: 'Règles de chargement',
    loading: 'Lecture des modules…', hint: 'Coché signifie charger à la prochaine ouverture. Les entrées nécessaires au démarrage sont protégées ; l’enregistrement explique les conflits de dépendances sans décocher d’autres modules.',
    save: 'Enregistrer la sélection', reset: 'Rétablir les valeurs par défaut', close: 'Fermer', required: 'Requis au démarrage', dependencies: 'Dépend de : ', noDependencies: 'Aucune dépendance frontend déclarée', details: 'Détails du module', moduleId: 'ID du module',
    saved: 'Enregistré pour la prochaine ouverture de DSH. Cette page n’est pas actualisée et le brouillon est conservé.', failed: 'Impossible de lire les modules. Activez l’accès mobile et réessayez.', saveFailed: 'L’enregistrement n’est pas confirmé. Vos choix sont conservés. Enregistrez de nouveau ou relisez les paramètres enregistrés.',
    conflict: 'Impossible d’enregistrer : ', catalogChanged: 'Le catalogue des modules a changé (mise à jour d’un plugin ou d’une version). Cet enregistrement a été annulé ; relisez les paramètres, puis confirmez de nouveau.', computerSource: 'Source : valeurs par défaut de l’ordinateur', deviceSource: 'Source : paramètres de cet appareil', pluginSource: 'Source : valeurs par défaut du plugin',
    resetConfirm: 'Rétablir les sélections par défaut pour la prochaine ouverture ? La conversation actuelle ne sera pas rechargée.', discardConfirm: 'Ignorer les choix de modules non enregistrés et fermer ?', reloadConfirm: 'La relecture remplace les choix non enregistrés. Continuer ?', savingCloseConfirm: 'L’enregistrement n’est pas confirmé. Fermer n’annulera pas un enregistrement qui a pu aboutir. Fermer quand même ?',
    search: 'Rechercher des modules', searchPlaceholder: 'Rechercher un nom ou un ID de module', filter: 'Sélection de chargement', all: 'Tous', loaded: 'Charger', excluded: 'Ne pas charger', empty: 'Aucun module ne correspond à ces filtres.', clearFilters: 'Effacer les filtres',
    extensions: 'Extensions facultatives', extensionsHint: 'Modules frontend facultatifs ; un module n’est pas forcément un plugin complet.', advanced: 'Composants DSH facultatifs (avancé)', advancedHint: 'Composants frontend DSH facultatifs. Ne modifiez que les entrées que vous comprenez.', requiredGroup: 'Requis au démarrage', requiredHint: 'Ces modules garantissent le démarrage de la page et ne peuvent pas être désactivés.',
    changes: 'Non enregistré : {count} modifications', unchanged: 'Aucune modification non enregistrée', results: 'Correspondances {visible} / {total}', sizeHint: 'Triés par taille transférée ; les nombres sont des octets gzip. Les descriptions proviennent du paquet de chaque plugin ; elles ne valent pas approbation en amont.', total: 'Sélection ≈ {size}', totalUnknown: 'Total de la sélection : certaines tailles sont inconnues', minimal: 'Requis uniquement (chargement minimal)', minimalConfirm: 'Marquer comme non chargés tous les modules sauf les modules requis et leurs dépendances ? S’applique à la prochaine ouverture après l’enregistrement.', minimalDetail: 'Cela exclut {count} modules facultatifs ; total gzip mesuré : {size} ; {unknown} non mesurés. Les modules requis et leurs dépendances restent chargés.', retry: 'Relire les paramètres', saving: 'Enregistrement…', readTimeout: 'La lecture a expiré. Cette page et les paramètres enregistrés ne changent pas ; réessayez.', writeTimeout: 'L’enregistrement a expiré et son résultat n’est pas confirmé. Vos choix sont conservés. Relisez pour confirmer ; aucun nouvel essai automatique.', nextOpen: 'S’applique uniquement à la prochaine ouverture',
    invalidSelections: 'Sélections obsolètes', invalidHint: 'Ces anciennes exclusions ne correspondent plus au catalogue des modules. Enregistrez vos choix après les avoir supprimées.', invalidMissing: 'Absent du catalogue actuel des modules.', invalidRequired: 'Désormais requis au démarrage et impossible à exclure.', clearInvalid: 'Supprimer l’ancienne exclusion',
  },
  de: {
    measure: 'Größen messen', measuring: 'Messung läuft…', cancelMeasure: 'Messung abbrechen', measured: 'Die Messung ist beendet; nicht messbare Größen bleiben unbekannt. Ihre Modulauswahl ist unverändert.', measureFailed: 'Die Messung wurde nicht abgeschlossen. Ihre Auswahl und bekannte Größen bleiben erhalten.', totalPartial: 'Gemessen ≈ {size}; {count} Größen unbekannt',
    title: 'Module der mobilen Seite', computer: 'Mobile Standardwerte für diesen Computer. Die Plugins des Computers bleiben unverändert.', device: 'Nur für das nächste Öffnen auf diesem Gerät. Die Plugins des Computers bleiben unverändert.', open: 'Verwalten', help: 'Laderegeln',
    loading: 'Module werden gelesen…', hint: 'Aktiviert bedeutet Laden beim nächsten Öffnen. Für den Start erforderliche Einträge sind geschützt; beim Speichern werden Abhängigkeitskonflikte erklärt, ohne andere Module abzuwählen.',
    save: 'Auswahl speichern', reset: 'Standardwerte wiederherstellen', close: 'Schließen', required: 'Für den Start erforderlich', dependencies: 'Hängt ab von: ', noDependencies: 'Keine deklarierten Frontend-Abhängigkeiten', details: 'Moduldetails', moduleId: 'Modul-ID',
    saved: 'Für das nächste Öffnen von DSH gespeichert. Diese Seite wird nicht aktualisiert, der Entwurf bleibt erhalten.', failed: 'Module konnten nicht gelesen werden. Aktivieren Sie den mobilen Zugriff und versuchen Sie es erneut.', saveFailed: 'Das Speichern wurde nicht bestätigt. Ihre Auswahl bleibt erhalten. Speichern Sie erneut oder lesen Sie die gespeicherten Einstellungen neu ein.',
    conflict: 'Speichern nicht möglich: ', catalogChanged: 'Der Modulkatalog hat sich geändert (Plugin- oder Versionsupdate). Dieses Speichern wurde abgebrochen; lesen Sie die Einstellungen neu ein und bestätigen Sie erneut.', computerSource: 'Quelle: Standardwerte des Computers', deviceSource: 'Quelle: Einstellungen dieses Geräts', pluginSource: 'Quelle: Plugin-Standardwerte',
    resetConfirm: 'Die Standardauswahl für das nächste Öffnen wiederherstellen? Die aktuelle Unterhaltung wird nicht neu geladen.', discardConfirm: 'Nicht gespeicherte Modulauswahl verwerfen und schließen?', reloadConfirm: 'Neu einlesen ersetzt nicht gespeicherte Auswahl. Fortfahren?', savingCloseConfirm: 'Das Speichern ist nicht bestätigt. Schließen macht ein möglicherweise abgeschlossenes Speichern nicht rückgängig. Trotzdem schließen?',
    search: 'Module suchen', searchPlaceholder: 'Name oder Modul-ID suchen', filter: 'Ladeauswahl', all: 'Alle', loaded: 'Laden', excluded: 'Nicht laden', empty: 'Keine Module entsprechen diesen Filtern.', clearFilters: 'Filter zurücksetzen',
    extensions: 'Optionale Erweiterungen', extensionsHint: 'Optionale Frontend-Module; ein Modul ist nicht zwangsläufig ein vollständiges Plugin.', advanced: 'Optionale DSH-Komponenten (erweitert)', advancedHint: 'Optionale DSH-Frontend-Komponenten. Ändern Sie nur Einträge, die Sie verstehen.', requiredGroup: 'Für den Start erforderlich', requiredHint: 'Diese Module halten die Seite startfähig und können nicht deaktiviert werden.',
    changes: 'Nicht gespeichert: {count} Änderungen', unchanged: 'Keine nicht gespeicherten Änderungen', results: 'Treffer {visible} / {total}', sizeHint: 'Nach Übertragungsgröße sortiert; Zahlen sind gzip-Bytes. Beschreibungen stammen aus dem jeweiligen Plugin-Paket und sind keine Bestätigung durch das Upstream.', total: 'Auswahl ≈ {size}', totalUnknown: 'Auswahl gesamt: einige Größen sind unbekannt', minimal: 'Nur erforderliche (minimales Laden)', minimalConfirm: 'Alle Module außer den für den Start erforderlichen und ihren Abhängigkeiten als nicht geladen markieren? Gilt beim nächsten Öffnen nach dem Speichern.', minimalDetail: 'Dies schließt {count} optionale Module aus; gemessene gzip-Summe: {size}; {unknown} bleiben ungemessen. Erforderliche Module und ihre Abhängigkeiten bleiben geladen.', retry: 'Einstellungen neu einlesen', saving: 'Speichern…', readTimeout: 'Zeitüberschreitung beim Lesen. Diese Seite und die gespeicherten Einstellungen sind unverändert; versuchen Sie es erneut.', writeTimeout: 'Zeitüberschreitung beim Speichern, das Ergebnis ist unbestätigt. Ihre Auswahl bleibt erhalten. Lesen Sie zur Bestätigung neu ein; es wird nicht automatisch erneut gespeichert.', nextOpen: 'Gilt nur beim nächsten Öffnen',
    invalidSelections: 'Veraltete Auswahl', invalidHint: 'Diese alten Ausschlüsse passen nicht mehr zum Modulkatalog. Speichern Sie Ihre Auswahl, nachdem Sie sie entfernt haben.', invalidMissing: 'Im aktuellen Modulkatalog nicht vorhanden.', invalidRequired: 'Jetzt für den Start erforderlich und nicht ausschließbar.', clearInvalid: 'Alten Ausschluss entfernen',
  },
} as const

interface ClientModuleView {
  readonly entries: readonly ClientModuleRow[]
  /** Catalog fingerprint from a server that reports one; older gateways omit it. */
  readonly revision?: string
  readonly excludedClientModules: readonly string[]
  readonly source: 'device' | 'computer' | 'plugin'
}

class ClientModuleUiConflict extends Error {
  constructor(readonly detail: string, readonly code: 'invalid_selection' | 'catalog_changed' = 'invalid_selection') {
    super('client_module_conflict')
  }
}

/** A deadline does not imply that a POST was rolled back by the server. */
export class ClientModuleRequestTimeout extends Error {
  constructor(readonly mutation: boolean) { super('client_module_request_timeout') }
}

export const CLIENT_MODULE_REQUEST_TIMEOUT_MS = { read: 15_000, write: 20_000 } as const

/** Describe measured bytes without presenting unmeasured modules as a complete total. */
export function clientModuleTotalLabel(draft: ClientModuleDraft | undefined, locale: MobileControlLocale): string {
  const copy = CLIENT_MODULE_COPY[locale]
  const unknownSizes = draft?.loadedUnknownSizeCount() ?? 0
  const size = formatClientModuleSize({ id: '', required: false, dependencies: [], gzipBytes: draft?.loadedTransferBytes() ?? 0 }) ?? '0 KB'
  return unknownSizes > 0
    ? copy.totalPartial.replace('{size}', size).replace('{count}', String(unknownSizes))
    : copy.total.replace('{size}', size)
}

/** Validate catalog response fields before creating interactive controls.
 * @param value - Gateway or computer-admin JSON response.
 * @returns The fields used by the module-selection dialog.
 */
export function parseClientModuleView(value: unknown): ClientModuleView {
  if (typeof value !== 'object' || value === null || !('entries' in value) || !Array.isArray(value.entries)
    || !('excludedClientModules' in value) || !Array.isArray(value.excludedClientModules)
    || !('source' in value) || (value.source !== 'device' && value.source !== 'computer' && value.source !== 'plugin')) throw new Error('invalid_module_catalog')
  const entries = value.entries.map((entry: unknown): ClientModuleRow => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string'
      || !('required' in entry) || typeof entry.required !== 'boolean' || !('dependencies' in entry) || !Array.isArray(entry.dependencies)) throw new Error('invalid_module_catalog')
    const dependencies = entry.dependencies.map((dependency: unknown): string => {
      if (typeof dependency !== 'string') throw new Error('invalid_module_catalog')
      return dependency
    })
    if (entry.id.trim() === '') throw new Error('invalid_module_catalog')
    const sizes: { bytes?: number; gzipBytes?: number; description?: string } = {}
    for (const field of ['bytes', 'gzipBytes'] as const) {
      if (!(field in entry)) continue
      const measured = (entry as Record<string, unknown>)[field]
      if (typeof measured !== 'number' || !Number.isSafeInteger(measured) || measured < 0) throw new Error('invalid_module_catalog')
      sizes[field] = measured
    }
    if ('description' in entry) {
      const description = (entry as Record<string, unknown>).description
      if (typeof description !== 'string' || description.trim() === '' || description.length > 240) throw new Error('invalid_module_catalog')
      sizes.description = description
    }
    return { id: entry.id, required: entry.required, dependencies, ...sizes }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('invalid_module_catalog')
  const revision = (value as Record<string, unknown>).revision
  if (revision !== undefined && (typeof revision !== 'string' || revision === '' || revision.length > 64)) throw new Error('invalid_module_catalog')
  const excludedClientModules = value.excludedClientModules.map((id: unknown): string => {
    if (typeof id !== 'string') throw new Error('invalid_module_catalog')
    return id
  })
  return {
    entries,
    ...(typeof revision === 'string' ? { revision } : {}),
    excludedClientModules,
    source: value.source === 'device' ? 'device' : value.source === 'computer' ? 'computer' : 'plugin',
  }
}

/** Read or explicitly write module choices with a bounded, cancellable operation.
 * @param scope - Computer-admin endpoint or authenticated device endpoint.
 * @param signal - Owning dialog lifetime; cancellation cannot undo a completed write.
 * @param body - Omit for a read; supplied fields are sent once without automatic replay.
 * @returns Validated catalog fields returned by the selected endpoint.
 */
export async function requestClientModuleView(scope: 'computer' | 'device', signal: AbortSignal, body?: Record<string, unknown>): Promise<ClientModuleView> {
  if (signal.aborted) throw new DOMException('Dialog closed', 'AbortError')
  const controller = new AbortController()
  let rejectCancellation: (error: Error) => void = () => {}
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject })
  const abort = (): void => { controller.abort(); rejectCancellation(new DOMException('Dialog closed', 'AbortError')) }
  signal.addEventListener('abort', abort, { once: true })
  const mutation = body !== undefined && body.measure !== true
  const timer = setTimeout(() => {
    rejectCancellation(new ClientModuleRequestTimeout(mutation))
    controller.abort()
  }, mutation ? CLIENT_MODULE_REQUEST_TIMEOUT_MS.write : CLIENT_MODULE_REQUEST_TIMEOUT_MS.read)
  const operation = async (): Promise<ClientModuleView> => {
    const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
    init.headers = scope === 'computer' ? localAdminRequestHeaders(init, location) : { 'content-type': 'application/json' }
    if (scope === 'device' && body !== undefined) {
      const cookies = document.cookie.split(';').map(value => value.trim())
      const csrfCookie = cookies.find(value => value.startsWith('__Host-dsh_ma_csrf=')) ?? cookies.find(value => value.startsWith('dsh_ma_csrf='))
      if (csrfCookie !== undefined) {
        const headers = new Headers(init.headers)
        headers.set('x-dsh-mobile-csrf', csrfCookie.slice(csrfCookie.indexOf('=') + 1))
        init.headers = headers
      }
    }
    const response = await fetch(scope === 'computer' ? '/api/mobile-access/client-modules' : '/mobile-access/client-modules', init)
    const value: unknown = await response.json()
    if (!response.ok) {
      const detail = typeof value === 'object' && value !== null && 'detail' in value && typeof value.detail === 'string' ? value.detail.slice(0, 512) : ''
      const code = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string' ? value.error : ''
      if (response.status === 409 && detail !== '' && code === 'client_module_catalog_changed') throw new ClientModuleUiConflict(detail, 'catalog_changed')
      if (response.status === 409 && detail !== '' && code === 'excluded_client_modules_invalid') throw new ClientModuleUiConflict(detail)
      throw new Error('client_module_request_failed')
    }
    return parseClientModuleView(value)
  }
  try { return await Promise.race([operation(), cancellation]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

export const CLIENT_MODULE_STYLES = `
.dsh-module-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-module-rowText{flex:1;min-width:0}.dsh-module-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-module-description{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-module-button{min-height:48px;padding:0 14px;border:0;border-radius:24px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
.dsh-module-button:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb);outline-offset:2px}
.dsh-module-button:not(:disabled):active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-module-dialog{box-sizing:border-box;width:min(640px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel,20px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#171a21);font:16px/1.5 var(--dsw-font-family,sans-serif);overflow:hidden}
.dsh-module-dialog[open]{display:flex;flex-direction:column}.dsh-module-dialog::backdrop{background:rgb(15 23 42 / 40%)}
.dsh-module-header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.dsh-module-header h2{flex:1;min-width:0;font-size:20px;line-height:1.4;margin:0;overflow-wrap:anywhere}.dsh-module-header .dsh-module-button{flex:none}
.dsh-module-packageDescription{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-module-description-full{margin:4px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.dsh-module-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px;scroll-padding:12px}.dsh-module-dialog p{margin:0 0 12px;overflow-wrap:anywhere}
.dsh-module-hint,.dsh-module-source,.dsh-module-choice small,.dsh-module-groupHint,.dsh-module-results{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary))}
.dsh-module-tools{display:grid;grid-template-columns:minmax(0,1fr) minmax(100px,.45fr);gap:12px;margin:16px 0 8px}.dsh-module-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:13px}
.dsh-module-help>summary{box-sizing:border-box;min-height:48px;padding:12px 0;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-module-field input,.dsh-module-field select{box-sizing:border-box;width:100%;min-width:0;min-height:48px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:16px}
.dsh-module-dialog :is(input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb);outline-offset:2px}
.dsh-module-list{display:flex;flex-direction:column;gap:16px;margin:12px 0}.dsh-module-group h3{margin:0 0 8px;font-size:16px;line-height:24px}
.dsh-module-group>summary{min-height:48px;cursor:pointer;font-weight:600;overflow-wrap:anywhere;align-content:center}.dsh-module-group>summary+div{margin-top:8px}
.dsh-module-entry{border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 0}.dsh-module-choice{display:flex;align-items:center;gap:12px;min-height:48px;cursor:pointer}
.dsh-module-choice input{width:24px;height:24px;flex:none;margin:0}.dsh-module-choice span{min-width:0;overflow-wrap:anywhere}.dsh-module-choiceName{display:block;font-weight:500}
.dsh-module-choice small{display:block}.dsh-module-entryDetails{margin-left:36px;min-width:0}.dsh-module-entryDetails summary{min-height:48px;align-content:center;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary))}
.dsh-module-invalid-entry code{display:block;min-width:0;overflow-wrap:anywhere;white-space:normal;font-size:13px}.dsh-module-invalid-entry .dsh-module-button{max-width:100%;white-space:normal;line-height:20px;padding:8px 14px}
.dsh-module-entryDetails p,.dsh-module-entryDetails code{overflow-wrap:anywhere;font-size:13px}.dsh-module-entryDetails code{white-space:normal}
.dsh-module-footer{flex:none;padding:12px 16px max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,#fff)}
.dsh-module-footer p{font-size:13px;line-height:20px;margin:0 0 8px}.dsh-module-actions{display:flex;flex-wrap:wrap;gap:8px}.dsh-module-actions .dsh-module-button{flex:1;min-width:0;white-space:normal;line-height:20px;padding:8px 12px}
.dsh-module-button:disabled{opacity:.5;cursor:default}.dsh-module-save{background:var(--dsw-alias-bg-module-platform);font-weight:600}
.dsh-module-notice:empty{display:none}.dsh-module-notice{max-height:min(96px,24dvh);overflow:auto;font-size:14px;line-height:22px;overscroll-behavior:contain}.dsh-module-empty{padding:16px 0}
@media(max-width:420px){.dsh-module-tools{grid-template-columns:minmax(0,1fr)}.dsh-module-body{padding:12px}.dsh-module-header,.dsh-module-footer{padding-left:12px;padding-right:12px}.dsh-module-header{flex-wrap:wrap;gap:8px}.dsh-module-header h2{flex:1 1 100%}.dsh-module-header .dsh-module-button{flex:1 1 0;min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.4;padding:8px 12px}}
.dsh-module-error{color:var(--dsw-alias-state-error-primary,#b42318)}
`

interface OpenClientModuleDialog { readonly dispose: () => void; readonly requestClose: () => void }
const openDialogs = new Set<OpenClientModuleDialog>()

/** Cancel pending dialogs when the owning plugin generation is disposed. */
export function disposeClientModuleDialogs(): void { for (const dialog of [...openDialogs]) dialog.dispose() }

/** Close the foreground module modal before navigating its underlying DSH settings.
 * @returns Whether an open module modal consumed the return action.
 */
export function closeClientModuleDialog(): boolean {
  const dialog = [...openDialogs].at(-1)
  if (dialog === undefined) return false
  dialog.requestClose()
  return true
}

/** Open one modal; closing cancels reads and restores focus without reloading the page.
 * @param scope - Computer defaults or the authenticated device's own override.
 * @param locale - Current DSH display language.
 * @param trigger - Control to focus again when the modal closes.
 */
export function openClientModuleSettings(scope: 'computer' | 'device', locale: MobileControlLocale, trigger?: HTMLElement): void {
  const copy = CLIENT_MODULE_COPY[locale]
  const controller = new AbortController()
  const dialog = document.createElement('dialog'); dialog.className = 'dsh-module-dialog'; dialog.setAttribute('aria-label', copy.title); dialog.lang = locale
  const button = (text: string): HTMLButtonElement => { const result = document.createElement('button'); result.type = 'button'; result.className = 'dsh-module-button'; result.textContent = text; return result }
  const paragraph = (text: string, className = ''): HTMLParagraphElement => { const result = document.createElement('p'); result.textContent = text; result.className = className; return result }
  const header = document.createElement('div'); header.className = 'dsh-module-header'
  const title = document.createElement('h2'); title.textContent = copy.title
  const close = button(copy.close); const measure = button(copy.measure); measure.dataset.clientModuleMeasure = 'true'; header.append(title, measure, close)
  const body = document.createElement('div'); body.className = 'dsh-module-body'
  const intro = paragraph(copy[scope]); const hint = paragraph(copy.hint, 'dsh-module-hint')
  const help = document.createElement('details'); help.className = 'dsh-module-help'
  const helpTitle = document.createElement('summary'); helpTitle.textContent = copy.help; help.append(helpTitle, hint)
  help.append(paragraph(copy.sizeHint, 'dsh-module-hint'))
  const source = paragraph('', 'dsh-module-source')
  const status = paragraph('', 'dsh-module-notice'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.tabIndex = -1
  const tools = document.createElement('div'); tools.className = 'dsh-module-tools'
  const searchLabel = document.createElement('label'); searchLabel.className = 'dsh-module-field'; searchLabel.textContent = copy.search
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = copy.searchPlaceholder; search.setAttribute('aria-label', copy.search); searchLabel.append(search)
  const filterLabel = document.createElement('label'); filterLabel.className = 'dsh-module-field'; filterLabel.textContent = copy.filter
  const filter = document.createElement('select'); filter.dataset.clientModuleFilter = 'true'; filter.setAttribute('aria-label', copy.filter)
  for (const value of ['all', 'loaded', 'excluded'] as const) { const option = document.createElement('option'); option.value = value; option.textContent = copy[value]; filter.append(option) }
  filterLabel.append(filter); tools.append(searchLabel, filterLabel)
  const results = paragraph('', 'dsh-module-results'); results.setAttribute('aria-live', 'polite')
  const list = document.createElement('div'); list.className = 'dsh-module-list'
  const footer = document.createElement('div'); footer.className = 'dsh-module-footer'
  const changes = paragraph(copy.unchanged); changes.setAttribute('role', 'status'); changes.setAttribute('aria-live', 'polite')
  const actions = document.createElement('div'); actions.className = 'dsh-module-actions'
  const save = button(copy.save); save.classList.add('dsh-module-save'); const minimal = button(copy.minimal); const reset = button(copy.reset); const reread = button(copy.retry)
  actions.append(save, reset, reread); footer.append(changes, status, actions)
  body.append(intro, source, tools, results, minimal, list, help); dialog.append(header, body, footer)
  let disposed = false
  let busy: 'read' | 'write' | 'measure' | undefined
  let measurementController: AbortController | undefined
  let generation = 0
  let draft: ClientModuleDraft | undefined
  let catalogRevision: string | undefined
  let unconfirmedWrite = false
  const expansion = new Map<ClientModuleGroup, boolean>([['extensions', true], ['advanced', false], ['required', false]])
  const choices = new Map<string, HTMLInputElement>()
  const invalidActions = new Map<string, HTMLButtonElement>()
  const filterValue = (): ClientModuleFilter => filter.value === 'loaded' ? 'loaded' : filter.value === 'excluded' ? 'excluded' : 'all'
  const updateControls = (): void => {
    const changed = draft?.changeCount ?? 0
    save.disabled = busy !== undefined || changed === 0; reset.disabled = busy !== undefined || draft === undefined; minimal.disabled = busy !== undefined || draft === undefined
    measure.disabled = (busy !== undefined && busy !== 'measure') || draft === undefined
    measure.textContent = busy === 'measure' ? copy.cancelMeasure : copy.measure
    reread.disabled = busy !== undefined; search.disabled = busy !== undefined || draft === undefined; filter.disabled = search.disabled
    save.textContent = busy === 'write' ? copy.saving : copy.save
    const total = clientModuleTotalLabel(draft, locale)
    changes.textContent = `${changed === 0 ? copy.unchanged : copy.changes.replace('{count}', String(changed))} · ${total} · ${copy.nextOpen}`
    list.setAttribute('aria-busy', String(busy !== undefined))
    for (const input of choices.values()) input.disabled = busy !== undefined || input.dataset.required === 'true'
    for (const action of invalidActions.values()) action.disabled = busy !== undefined
  }
  const renderList = (): void => {
    choices.clear(); invalidActions.clear(); list.replaceChildren()
    if (draft === undefined) { results.textContent = ''; return }
    const visible = draft.matchingEntries(search.value, filterValue())
    const invalid = draft.matchingInvalidExclusions(search.value, filterValue())
    results.textContent = copy.results.replace('{visible}', String(visible.length + invalid.length)).replace('{total}', String(draft.entries.length + draft.invalidExclusions.length))
    const filtered = search.value.trim() !== '' || filterValue() !== 'all'
    if (visible.length === 0 && invalid.length === 0) {
      const empty = document.createElement('div'); empty.className = 'dsh-module-empty'; empty.append(paragraph(copy.empty))
      const clear = button(copy.clearFilters); clear.addEventListener('click', () => { search.value = ''; filter.value = 'all'; renderList(); search.focus({ preventScroll: true }) }); empty.append(clear); list.append(empty)
    }
    if (invalid.length > 0) {
      const section = document.createElement('section'); section.className = 'dsh-module-group'; section.dataset.clientModuleGroup = 'invalid'
      const heading = document.createElement('h3'); heading.textContent = `${copy.invalidSelections} (${invalid.length})`
      section.append(heading, paragraph(copy.invalidHint, 'dsh-module-groupHint'))
      for (const entry of invalid) {
        const row = document.createElement('div'); row.className = 'dsh-module-entry dsh-module-invalid-entry'; row.dataset.invalidClientModuleId = entry.id
        const id = document.createElement('code'); id.textContent = entry.id
        const remove = button(copy.clearInvalid); remove.setAttribute('aria-label', `${copy.clearInvalid}: ${entry.id}`)
        remove.addEventListener('click', () => {
          if (disposed || busy !== undefined || draft?.clearInvalidExclusion(entry.id) !== true) return
          status.textContent = ''; status.classList.remove('dsh-module-error'); renderList()
          const nextAction = invalidActions.values().next().value ?? save
          nextAction.focus({ preventScroll: true })
        })
        row.append(id, paragraph(entry.reason === 'missing' ? copy.invalidMissing : copy.invalidRequired), remove)
        invalidActions.set(entry.id, remove); section.append(row)
      }
      list.append(section)
    }
    for (const group of ['extensions', 'advanced', 'required'] as const) {
      const entries = sortClientModulesBySize(visible.filter(entry => clientModuleGroup(entry) === group))
      if (entries.length === 0) continue
      const section = document.createElement(group === 'extensions' ? 'section' : 'details'); section.className = 'dsh-module-group'; section.dataset.group = group
      section.dataset.clientModuleGroup = group === 'advanced' ? 'system' : group
      const headingText = `${group === 'required' ? copy.requiredGroup : copy[group]} (${entries.length})`
      if (section instanceof HTMLDetailsElement) {
        section.open = filtered || expansion.get(group) === true
        const heading = document.createElement('summary'); heading.textContent = headingText; section.append(heading)
        section.addEventListener('toggle', () => { if (!filtered) expansion.set(group, section.open) })
      } else { const heading = document.createElement('h3'); heading.textContent = headingText; section.append(heading) }
      const content = document.createElement('div'); content.append(paragraph(group === 'required' ? copy.requiredHint : group === 'advanced' ? copy.advancedHint : copy.extensionsHint, 'dsh-module-groupHint'))
      for (const entry of entries) {
        const row = document.createElement('div'); row.className = 'dsh-module-entry'; row.dataset.clientModuleId = entry.id
        const label = document.createElement('label'); label.className = 'dsh-module-choice'
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = draft.isLoaded(entry.id); if (entry.required) input.dataset.required = 'true'
        const name = document.createElement('span'); const shortName = document.createElement('span'); shortName.className = 'dsh-module-choiceName'; shortName.textContent = clientModuleDisplayName(entry.id)
        const selected = document.createElement('small'); selected.textContent = entry.required ? copy.required : input.checked ? copy.loaded : copy.excluded
        const size = formatClientModuleSize(entry)
        const sizeLabel = document.createElement('small'); sizeLabel.className = 'dsh-module-size'; sizeLabel.textContent = size ?? ''
        if (size !== undefined) sizeLabel.dataset.clientModuleSize = 'true'
        name.append(shortName, selected, sizeLabel); label.append(input, name); row.append(label)
        if (entry.description !== undefined) {
          const summary = paragraph(entry.description, 'dsh-module-packageDescription')
          summary.dataset.clientModuleDescription = 'true'
          row.append(summary)
        }
        const detail = document.createElement('details'); detail.className = 'dsh-module-entryDetails'
        const detailSummary = document.createElement('summary'); detailSummary.textContent = copy.details
        const id = paragraph(`${copy.moduleId}: `); const code = document.createElement('code'); code.textContent = entry.id; id.append(code)
        detail.append(detailSummary, id)
        if (entry.description !== undefined) detail.append(paragraph(entry.description, 'dsh-module-description-full'))
        detail.append(paragraph(entry.dependencies.length === 0 ? copy.noDependencies : `${copy.dependencies}${entry.dependencies.join(', ')}`)); row.append(detail)
        input.addEventListener('change', () => {
          if (busy !== undefined || draft === undefined) return
          draft.setLoaded(entry.id, input.checked); input.checked = draft.isLoaded(entry.id); selected.textContent = entry.required ? copy.required : input.checked ? copy.loaded : copy.excluded
          status.textContent = ''; status.classList.remove('dsh-module-error')
          if (filterValue() !== 'all') { renderList(); filter.focus({ preventScroll: true }) }
          updateControls()
        })
        choices.set(entry.id, input); content.append(row)
      }
      section.append(content); list.append(section)
    }
    updateControls()
  }
  const render = (view: ClientModuleView): void => {
    draft = new ClientModuleDraft(view.entries, view.excludedClientModules)
    catalogRevision = view.revision
    source.textContent = view.source === 'device' ? copy.deviceSource : view.source === 'computer' ? copy.computerSource : copy.pluginSource
    renderList()
  }
  const failed = (error: unknown, mutation: boolean): void => {
    status.classList.add('dsh-module-error')
    status.textContent = error instanceof ClientModuleUiConflict
      ? (error.code === 'catalog_changed' ? copy.catalogChanged : `${copy.conflict}${error.detail}`)
      : error instanceof ClientModuleRequestTimeout ? (error.mutation ? copy.writeTimeout : copy.readTimeout) : mutation ? copy.saveFailed : copy.failed
    status.focus({ preventScroll: true })
  }
  const runRequest = (payload?: Record<string, unknown>): void => {
    if (disposed || busy !== undefined || (payload !== undefined && draft === undefined)) return
    const measuring = payload?.measure === true
    const mutation = payload !== undefined && !measuring
    const ownGeneration = ++generation; busy = measuring ? 'measure' : mutation ? 'write' : 'read'
    if (mutation) unconfirmedWrite = true
    if (measuring) measurementController = new AbortController()
    status.classList.remove('dsh-module-error'); status.textContent = measuring ? copy.measuring : mutation ? copy.saving : copy.loading; updateControls()
    void requestClientModuleView(scope, measuring ? measurementController!.signal : controller.signal, payload).then(view => {
      if (disposed || ownGeneration !== generation) return
      if (measuring && draft !== undefined) { draft.updateMeasurements(view.entries); renderList() }
      else { unconfirmedWrite = false; render(view) }
      status.textContent = measuring ? copy.measured : mutation ? copy.saved : ''
    }, error => {
      if (disposed || ownGeneration !== generation) return
      if (measuring) { status.textContent = copy.measureFailed; return }
      if (error instanceof ClientModuleUiConflict) unconfirmedWrite = false
      failed(error, mutation)
    }).finally(() => {
      if (disposed || ownGeneration !== generation) return
      measurementController = undefined
      busy = undefined; updateControls()
    })
  }
  search.addEventListener('input', renderList); filter.addEventListener('change', renderList)
  save.addEventListener('click', () => { if ((draft?.changeCount ?? 0) > 0) runRequest({ excludedClientModules: draft?.excludedIds, ...(catalogRevision === undefined ? {} : { revision: catalogRevision }) }) })
  reset.addEventListener('click', () => { if (busy === undefined && draft !== undefined && window.confirm(copy.resetConfirm)) runRequest({ reset: true }) })
  minimal.addEventListener('click', () => {
    if (busy !== undefined || draft === undefined) return
    const impact = clientModuleMinimalImpact(draft.entries)
    const detail = copy.minimalDetail
      .replace('{count}', String(impact.count))
      .replace('{size}', impact.gzipBytes === undefined ? '—' : formatClientModuleSize({ id: '', required: false, dependencies: [], gzipBytes: impact.gzipBytes }) ?? '—')
      .replace('{unknown}', String(impact.unknown))
    if (!window.confirm(`${copy.minimalConfirm}\n\n${detail}`)) return
    if (draft.applyMinimalSelection()) { renderList(); search.focus({ preventScroll: true }) }
    updateControls()
  })
  measure.addEventListener('click', () => {
    if (busy === 'measure') measurementController?.abort()
    else if (busy === undefined && draft !== undefined) runRequest({ measure: true })
  })
  reread.addEventListener('click', () => { if (busy === undefined && ((draft?.changeCount ?? 0) === 0 || window.confirm(copy.reloadConfirm))) runRequest() })
  const dispose = (): void => {
    if (disposed) return
    disposed = true; ++generation; controller.abort(); measurementController?.abort(); openDialogs.delete(openDialog); window.removeEventListener('dsh-mobile:native-back', onBack, true); window.removeEventListener('keydown', onEscape, true); if (dialog.open) dialog.close(); dialog.remove()
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
  const requestClose = (): void => {
    if (disposed) return
    if (unconfirmedWrite && !window.confirm(copy.savingCloseConfirm)) return
    if (!unconfirmedWrite && (draft?.changeCount ?? 0) > 0 && !window.confirm(copy.discardConfirm)) return
    dispose()
  }
  const onBack = (event: Event): void => {
    if (!event.cancelable || !dialog.open || event.defaultPrevented || [...openDialogs].at(-1) !== openDialog) return
    event.preventDefault(); event.stopImmediatePropagation(); requestClose()
  }
  // Own Escape before the stock settings listener closes the layer underneath.
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
      || event.defaultPrevented || !dialog.open || [...openDialogs].at(-1) !== openDialog) return
    event.preventDefault(); event.stopImmediatePropagation(); requestClose()
  }
  const openDialog = { dispose, requestClose }
  openDialogs.add(openDialog); window.addEventListener('dsh-mobile:native-back', onBack, true)
  window.addEventListener('keydown', onEscape, true)
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose() })
  dialog.addEventListener('close', dispose, { once: true }); close.addEventListener('click', requestClose)
  document.body.append(dialog); dialog.showModal(); runRequest()
}

/** Settings row used on mobile pages and on the computer's General settings.
 * @param props - Selection scope and current locale.
 * @returns A native-style General settings row.
 */
export function ClientModuleSettingsRow(props: { readonly scope: 'computer' | 'device'; readonly locale: MobileControlLocale }): ReactElement {
  const copy = CLIENT_MODULE_COPY[props.locale]
  return createElement('div', { className: 'dsh-module-row', lang: props.locale },
    createElement('div', { className: 'dsh-module-rowText' }, createElement('div', { className: 'dsh-module-title' }, copy.title), createElement('div', { className: 'dsh-module-description' }, copy[props.scope])),
    createElement('button', { type: 'button', className: 'dsh-module-button', onClick: (event: { currentTarget: HTMLElement }) => { openClientModuleSettings(props.scope, props.locale, event.currentTarget) } }, copy.open),
  )
}
