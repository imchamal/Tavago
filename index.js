import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// Tavago 확장프로그램의 이름과 폴더 경로입니다.
// 실제 폴더 이름도 아래 위치의 Tavago와 같아야 합니다.
// public/scripts/extensions/third-party/Tavago
const extensionName = "Tavago";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Tavago가 직접 만든 메시지 번역 버튼에 붙일 CSS 클래스 이름입니다.
const messageButtonClass = "tavago_translate_message";
const activeButtonClass = "tavago-active";
const outdatedButtonClass = "tavago-outdated";
const errorButtonClass = "tavago-error";
const inputIconClass = "fa-solid fa-feather-pointed";
const longPressMs = 650;
const autoTranslateDelayMs = 1500;
const seenMessageIds = new Set();
let inputTranslationState = null;

// 처음 실행할 때 사용할 기본 설정입니다.
// 이미 저장된 설정이 있으면 getSettings()에서 이 값들과 합쳐집니다.
const defaultSettings = {
    targetLanguage: "ko",
    bidirectionalMode: "ko-en",
    autoTranslateMode: "ai",
    dualLineMode: false,
    customPrompt: "",
    systemPrompt: [
        "You are Tavago, a precise translation engine for SillyTavern chats.",
        "Translate the user's text into {{language}}.",
        "",
        "Rules:",
        "Return only the translated text.",
        "Preserve the original meaning, tone, and emotional nuance.",
        "Preserve character names, speaker labels, markdown, code blocks, links, and placeholders.",
        "Preserve roleplay formatting, including quoted speech, actions, thoughts, and line breaks.",
        "Do not add explanations, summaries, notes, or extra commentary.",
        "Do not censor, soften, or embellish the original text.",
    ].join("\n"),
};

// SillyTavern에 저장된 Tavago 설정을 읽습니다.
// 빠진 값이 있으면 위의 기본 설정으로 채워줍니다.
function getSettings() {
    const savedSettings = extension_settings[extensionName] || {};

    if (savedSettings.messageTargetLanguage && !savedSettings.targetLanguage) {
        savedSettings.targetLanguage = getLanguageCodeFromName(savedSettings.messageTargetLanguage);
    }

    if (savedSettings.inputTargetLanguage && !savedSettings.bidirectionalMode) {
        savedSettings.bidirectionalMode = "ko-en";
    }

    extension_settings[extensionName] = Object.assign(
        {},
        defaultSettings,
        savedSettings,
    );

    return extension_settings[extensionName];
}

// 설정 저장에는 짧은 코드(ko/en)를 쓰고, 프롬프트에는 영어 이름을 사용합니다.
function getLanguageName(languageCode) {
    if (languageCode === "en") {
        return "English";
    }

    return "Korean";
}

// 예전 설정처럼 Korean/English 문자열이 들어온 경우 새 코드로 바꿉니다.
function getLanguageCodeFromName(languageName) {
    const normalized = String(languageName || "").toLowerCase();

    if (normalized.includes("english") || normalized.includes("영어") || normalized === "en") {
        return "en";
    }

    return "ko";
}

// 목표 언어의 반대 언어를 구합니다. 한<->영 양방향 번역에서 입력창 번역에 사용합니다.
function getOppositeLanguageCode(languageCode) {
    return languageCode === "ko" ? "en" : "ko";
}

// 입력창 번역에 사용할 목표 언어를 계산합니다.
function getInputTargetLanguageCode() {
    const settings = getSettings();

    if (settings.bidirectionalMode === "ko-en") {
        return getOppositeLanguageCode(settings.targetLanguage);
    }

    return settings.targetLanguage;
}

// 메시지 번역에 사용할 목표 언어를 계산합니다.
function getMessageTargetLanguageCode() {
    return getSettings().targetLanguage;
}

// 일반 안내 메시지를 보여주는 함수입니다.
// SillyTavern에서는 보통 toastr 알림이 뜨고, 없으면 콘솔에 출력합니다.
function showInfo(message) {
    if (typeof toastr !== "undefined") {
        toastr.info(message, extensionName);
    } else {
        console.info(`[${extensionName}] ${message}`);
    }
}

// 오류 메시지를 보여주는 함수입니다.
function showError(message) {
    if (typeof toastr !== "undefined") {
        toastr.error(message, extensionName);
    } else {
        console.error(`[${extensionName}] ${message}`);
    }
}

// SillyTavern의 메인 입력창을 찾습니다.
// 사용자가 메시지를 보내기 전에 글을 쓰는 그 입력창입니다.
function getInputTextarea() {
    return document.querySelector("#send_textarea");
}

// 아주 단순한 한글 포함 여부 검사입니다.
function hasKoreanText(text) {
    return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text);
}

// 입력창 내용이 목표 언어와 이미 같은 것으로 보이면 true를 반환합니다.
function looksLikeTargetLanguage(text, targetLanguageCode) {
    if (targetLanguageCode === "ko") {
        return hasKoreanText(text);
    }

    return !hasKoreanText(text);
}

// 사용자가 입력창 내용을 직접 고쳤으면 기존 원문/번역문 전환 상태를 버립니다.
function getValidInputTranslationState(currentText) {
    if (!inputTranslationState) {
        return null;
    }

    if (
        currentText === inputTranslationState.originalText ||
        currentText === inputTranslationState.translatedText
    ) {
        return inputTranslationState;
    }

    inputTranslationState = null;
    return null;
}

// 입력창 값을 바꾸고 SillyTavern이 변경을 감지하게 input 이벤트를 보냅니다.
function setInputTextareaValue(textarea, text) {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// SillyTavern의 각 메시지 HTML에는 "mesid"라는 번호가 붙어 있습니다.
// 이 번호로 context.chat 안의 실제 메시지 데이터를 찾을 수 있습니다.
function getMessageIdFromBlock(messageBlock) {
    const messageId = messageBlock?.getAttribute("mesid");
    const parsedId = Number(messageId);

    return Number.isInteger(parsedId) ? parsedId : null;
}

// 메시지 안에 Tavago 전용 저장 공간을 준비합니다.
// 이전 테스트 버전에서 display_text에만 저장한 번역문도 여기로 옮겨 둡니다.
function getTavagoData(message) {
    message.extra = message.extra || {};
    message.extra.tavago = message.extra.tavago || {};

    if (message.extra.display_text && !message.extra.tavago.translated_text) {
        message.extra.tavago.translated_text = message.extra.display_text;
        message.extra.tavago.showing_translation = true;
    }

    return message.extra.tavago;
}

// 자동 번역 설정값에 따라 이 메시지를 자동 번역할지 판단합니다.
// off: 자동 번역 안 함, all: 전체, user: 유저 메시지만, ai: AI 메시지만
function shouldAutoTranslateMessage(message) {
    const settings = getSettings();

    if (!message || !message.mes) {
        return false;
    }

    if (settings.autoTranslateMode === "off") {
        return false;
    }

    if (settings.autoTranslateMode === "all") {
        return true;
    }

    if (settings.autoTranslateMode === "user") {
        return message.is_user === true;
    }

    if (settings.autoTranslateMode === "ai") {
        return message.is_user !== true;
    }

    return false;
}

// 이 메시지에 Tavago 번역문이 이미 저장되어 있는지 확인합니다.
function hasSavedTranslation(message) {
    const tavagoData = getTavagoData(message);

    return Boolean(tavagoData.translated_text);
}

// 저장된 번역문이 현재 메시지 번역 설정과 다른지 확인합니다.
// 목표 언어나 번역 지시문이 바뀌었으면 true가 됩니다.
function isTranslationOutdated(message) {
    const tavagoData = getTavagoData(message);

    if (!tavagoData.translated_text) {
        return false;
    }

    const promptInfo = buildTranslationPrompt(getMessageTargetLanguageCode(), "message");

    return (
        tavagoData.target_language !== promptInfo.targetLanguage ||
        tavagoData.prompt_used !== promptInfo.systemPrompt
    );
}

// 번역 실패 정보를 메시지의 Tavago 저장 공간에 남깁니다.
function markTranslationFailed(message, error) {
    const tavagoData = getTavagoData(message);
    const errorMessage = error?.message || String(error) || "번역 중 오류가 발생했습니다.";

    tavagoData.auto_translate_failed = true;
    tavagoData.last_error = errorMessage;
    tavagoData.last_error_at = Date.now();
}

// 번역이 성공하면 이전 실패 정보를 지웁니다.
function clearTranslationFailed(message) {
    const tavagoData = getTavagoData(message);

    tavagoData.auto_translate_failed = false;
    delete tavagoData.last_error;
    delete tavagoData.last_error_at;
}

// 저장된 번역문을 화면에 보여줍니다.
function showTranslation(message) {
    const tavagoData = getTavagoData(message);

    message.extra.display_text = tavagoData.translated_text;
    tavagoData.showing_translation = true;
}

// 원문을 화면에 보여줍니다.
// display_text를 지우면 SillyTavern이 원래 message.mes를 보여줍니다.
function showOriginal(message) {
    const tavagoData = getTavagoData(message);

    delete message.extra.display_text;
    tavagoData.showing_translation = false;
}

// 메시지 화면을 다시 그리고 채팅을 저장합니다.
async function refreshMessageAndSave(context, messageId, message) {
    if (typeof context.updateMessageBlock === "function") {
        context.updateMessageBlock(messageId, message);
    }

    if (typeof context.saveChat === "function") {
        await context.saveChat();
    }
}

// 버튼의 툴팁과 활성 표시를 현재 메시지 상태에 맞게 바꿉니다.
function updateMessageButtonState(message, button) {
    const tavagoData = getTavagoData(message);
    const isShowingTranslation = Boolean(tavagoData.showing_translation);
    const isOutdated = isTranslationOutdated(message);
    const hasError = Boolean(tavagoData.auto_translate_failed);

    button.toggleClass(activeButtonClass, isShowingTranslation);
    button.toggleClass(outdatedButtonClass, isOutdated);
    button.toggleClass(errorButtonClass, hasError);

    if (hasError) {
        button.attr("title", `최근 번역 실패: ${tavagoData.last_error || "오류 정보 없음"}. 길게 누르면 재번역`);
    } else if (!tavagoData.translated_text) {
        button.attr("title", "Tavago로 이 메시지 번역");
    } else if (isOutdated) {
        button.attr("title", "현재 메시지 번역 설정과 다른 번역입니다. 길게 누르면 재번역");
    } else if (isShowingTranslation) {
        button.attr("title", "원문 보기. 길게 누르면 재번역");
    } else {
        button.attr("title", "번역문 보기. 길게 누르면 재번역");
    }
}

// 실리태번 전송 버튼 근처에 입력창 번역 버튼을 붙입니다.
// 설정창에 있던 버튼과 같은 id를 쓰므로 기존 translateInputTextarea()가 그대로 작동합니다.
function addInputTranslateButtonToSendControls() {
    if (document.querySelector("#tavago_translate_input")) {
        return;
    }

    const sendButton = document.querySelector("#send_but");

    if (!sendButton || !sendButton.parentElement) {
        return;
    }

    const button = document.createElement("div");
    button.id = "tavago_translate_input";
    button.className = `${inputIconClass} interactable`;
    button.title = "Tavago 입력창 번역";
    button.tabIndex = 0;
    button.setAttribute("role", "button");

    let longPressTimer = null;
    let longPressHandled = false;

    const startLongPressTimer = (event) => {
        event.preventDefault();
        event.stopPropagation();
        longPressHandled = false;
        clearTimeout(longPressTimer);

        longPressTimer = setTimeout(async () => {
            longPressHandled = true;
            await retranslateInputTextarea();
        }, longPressMs);
    };

    const finishShortPress = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(longPressTimer);

        if (longPressHandled) {
            return;
        }

        await toggleInputTextareaTranslation();
    };

    const cancelPress = () => {
        clearTimeout(longPressTimer);
    };

    button.addEventListener("pointerdown", startLongPressTimer);
    button.addEventListener("pointerup", finishShortPress);
    button.addEventListener("pointerleave", cancelPress);
    button.addEventListener("pointercancel", cancelPress);
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener("keydown", async (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            await toggleInputTextareaTranslation();
        }
    });

    sendButton.parentElement.insertBefore(button, sendButton);
}

// 입력 영역이 늦게 그려지는 경우를 대비해 전송 버튼 영역을 감시합니다.
function watchInputTranslateButton() {
    addInputTranslateButtonToSendControls();

    const observer = new MutationObserver(addInputTranslateButtonToSendControls);
    observer.observe(document.body, { childList: true, subtree: true });
}

// 메시지 번역 요청을 시작할 수 있는지 확인합니다.
// 이미 번역 중이면 false를 돌려줘서 API 요청이 겹치지 않게 막습니다.
function beginMessageTranslation(message, button) {
    const tavagoData = getTavagoData(message);

    if (tavagoData.translation_in_progress) {
        return false;
    }

    tavagoData.translation_in_progress = true;
    button.prop("disabled", true);
    button.addClass("tavago-busy");

    return true;
}

// 메시지 번역 요청이 끝났을 때 상태를 원래대로 돌립니다.
function finishMessageTranslation(message, button) {
    const tavagoData = getTavagoData(message);

    tavagoData.translation_in_progress = false;
    button.prop("disabled", false);
    button.removeClass("tavago-busy");
    updateMessageButtonState(message, button);
}

// 지정한 목표 언어와 용도를 바탕으로 실제 번역 지시문을 만듭니다.
// 기본 Tavago 프롬프트는 유지하고, 사용자가 적은 추가 지시문을 뒤에 붙입니다.
function buildTranslationPrompt(targetLanguageCode, translationType = "message") {
    const settings = getSettings();
    const targetLanguage = getLanguageName(targetLanguageCode);
    const promptParts = [
        defaultSettings.systemPrompt.replaceAll("{{language}}", targetLanguage),
    ];

    if (translationType === "message" && settings.dualLineMode) {
        promptParts.push([
            "",
            "Dual-line display rule:",
            "For dialogue, thoughts, emphasized text, inline code-like messages, letters, or text messages, preserve the original segment and add the translation as [translation].",
            "Never wrap the original segment in square brackets.",
            "Never output [original][translation].",
            "The correct format is always: original [translation].",
            "If the original segment is wrapped in quotes or markdown delimiters, put [translation] INSIDE the same wrapper so the UI styles the original and translation together.",
            "Examples:",
            "\"I don't know.\" -> \"I don't know. [모르겠어.]\"",
            "*I should leave.* -> *I should leave. [떠나야 해.]*",
            "**Incoming message** -> **Incoming message [수신 메시지]**",
            "`text message` -> `text message [문자 메시지]`",
            "Do not make the bracketed translation bold unless the original segment itself is already bold.",
        ].join("\n"));
    }

    if (settings.customPrompt.trim()) {
        promptParts.push([
            "",
            "Additional user instructions:",
            settings.customPrompt.trim(),
        ].join("\n"));
    }

    return {
        targetLanguage,
        systemPrompt: promptParts.join("\n"),
    };
}

// 현재 SillyTavern에 연결된 API/모델에게 번역을 요청합니다.
// Tavago는 별도 API 키를 받지 않고 generateRaw()를 사용합니다.
async function translateText(text, targetLanguageCode, translationType = "message") {
    const context = getContext();
    const promptInfo = buildTranslationPrompt(targetLanguageCode, translationType);

    if (typeof context.generateRaw !== "function") {
        throw new Error("현재 SillyTavern에서 generateRaw()를 찾을 수 없습니다.");
    }

    const translatedText = await context.generateRaw({
        systemPrompt: promptInfo.systemPrompt,
        prompt: text,
    });

    return {
        text: translatedText,
        targetLanguage: promptInfo.targetLanguage,
        promptUsed: promptInfo.systemPrompt,
    };
}

// 입력창 내용을 새로 번역합니다.
async function translateInputTextarea(forceRetranslate = false) {
    const textarea = getInputTextarea();

    if (!(textarea instanceof HTMLTextAreaElement)) {
        showError("입력창을 찾지 못했습니다.");
        return;
    }

    const originalText = textarea.value.trim();
    const state = getValidInputTranslationState(textarea.value);

    if (!originalText) {
        showInfo("번역할 입력창 내용이 없습니다.");
        return;
    }

    if (state && !forceRetranslate) {
        setInputTextareaValue(textarea, state.translatedText);
        state.showingTranslation = true;
        return;
    }

    const settings = getSettings();
    const targetLanguageCode = getInputTargetLanguageCode();

    if (
        settings.bidirectionalMode === "off" &&
        looksLikeTargetLanguage(originalText, targetLanguageCode)
    ) {
        showInfo("이미 목표 언어로 작성된 것으로 보여 바꿀 내용이 없습니다.");
        return;
    }

    const button = $("#tavago_translate_input");
    button.prop("disabled", true);
    button.addClass("tavago-busy");

    try {
        const sourceText = state ? state.originalText : originalText;
        const result = await translateText(sourceText, targetLanguageCode, "input");
        const translatedText = result.text.trim();

        inputTranslationState = {
            originalText: sourceText,
            translatedText,
            showingTranslation: true,
            targetLanguage: result.targetLanguage,
            promptUsed: result.promptUsed,
            translatedAt: Date.now(),
        };

        setInputTextareaValue(textarea, translatedText);
        showInfo("입력창 번역이 완료되었습니다.");
    } catch (error) {
        console.error(error);
        showError(error.message || "번역 중 오류가 발생했습니다.");
    } finally {
        button.prop("disabled", false);
        button.removeClass("tavago-busy");
    }
}

// 입력창 아이콘을 짧게 눌렀을 때 원문/번역문을 전환합니다.
async function toggleInputTextareaTranslation() {
    const textarea = getInputTextarea();

    if (!(textarea instanceof HTMLTextAreaElement)) {
        showError("입력창을 찾지 못했습니다.");
        return;
    }

    const state = getValidInputTranslationState(textarea.value);

    if (!state) {
        await translateInputTextarea();
        return;
    }

    if (state.showingTranslation) {
        setInputTextareaValue(textarea, state.originalText);
        state.showingTranslation = false;
    } else {
        setInputTextareaValue(textarea, state.translatedText);
        state.showingTranslation = true;
    }
}

// 입력창 아이콘을 길게 눌렀을 때 원문 기준으로 다시 번역합니다.
async function retranslateInputTextarea() {
    const textarea = getInputTextarea();

    if (!(textarea instanceof HTMLTextAreaElement)) {
        showError("입력창을 찾지 못했습니다.");
        return;
    }

    const state = getValidInputTranslationState(textarea.value);

    if (state) {
        setInputTextareaValue(textarea, state.originalText);
        state.showingTranslation = false;
    }

    await translateInputTextarea(true);
}

// 메시지를 새로 번역해서 Tavago 저장 공간에 넣습니다.
// forceRetranslate가 true면 기존 번역문이 있어도 API에 다시 요청합니다.
async function translateAndSaveMessage(message, forceRetranslate = false) {
    const tavagoData = getTavagoData(message);

    if (tavagoData.translated_text && !forceRetranslate) {
        showTranslation(message);
        return false;
    }

    const result = await translateText(message.mes, getMessageTargetLanguageCode(), "message");
    tavagoData.translated_text = result.text.trim();
    tavagoData.target_language = result.targetLanguage;
    tavagoData.prompt_used = result.promptUsed;
    tavagoData.translated_at = Date.now();
    clearTranslationFailed(message);
    showTranslation(message);

    return true;
}

// 짧게 클릭했을 때 실행됩니다.
// 번역문이 없으면 번역하고, 이미 있으면 원문/번역문을 전환합니다.
async function toggleMessageTranslation(messageBlock, button) {
    const context = getContext();
    const messageId = getMessageIdFromBlock(messageBlock);
    const message = messageId === null ? null : context.chat?.[messageId];
    let startedTranslation = false;

    if (!message || !message.mes) {
        showError("번역할 메시지를 찾지 못했습니다.");
        return;
    }

    try {
        const tavagoData = getTavagoData(message);

        if (!hasSavedTranslation(message)) {
            if (!beginMessageTranslation(message, button)) {
                return;
            }

            startedTranslation = true;
            await translateAndSaveMessage(message);
            finishMessageTranslation(message, button);
            startedTranslation = false;
            showInfo("메시지 번역이 완료되었습니다.");
        } else if (tavagoData.showing_translation) {
            showOriginal(message);
        } else {
            showTranslation(message);
        }

        updateMessageButtonState(message, button);
        await refreshMessageAndSave(context, messageId, message);
    } catch (error) {
        markTranslationFailed(message, error);
        if (startedTranslation) {
            finishMessageTranslation(message, button);
            startedTranslation = false;
        }

        await refreshMessageAndSave(context, messageId, message);
        console.error(error);
        showError(error.message || "메시지 번역 중 오류가 발생했습니다.");
    } finally {
        if (startedTranslation) {
            finishMessageTranslation(message, button);
        } else {
            updateMessageButtonState(message, button);
        }

        addTranslateButtonsToMessages();
    }
}

// 길게 눌렀을 때 실행됩니다.
// 기존 번역문이 있어도 무시하고 새로 번역합니다.
async function retranslateMessage(messageBlock, button) {
    const context = getContext();
    const messageId = getMessageIdFromBlock(messageBlock);
    const message = messageId === null ? null : context.chat?.[messageId];
    let startedTranslation = false;

    if (!message || !message.mes) {
        showError("재번역할 메시지를 찾지 못했습니다.");
        return;
    }

    if (!beginMessageTranslation(message, button)) {
        return;
    }

    startedTranslation = true;

    try {
        await translateAndSaveMessage(message, true);
        finishMessageTranslation(message, button);
        startedTranslation = false;
        await refreshMessageAndSave(context, messageId, message);
        showInfo("메시지 재번역이 완료되었습니다.");
    } catch (error) {
        markTranslationFailed(message, error);
        if (startedTranslation) {
            finishMessageTranslation(message, button);
            startedTranslation = false;
        }

        await refreshMessageAndSave(context, messageId, message);
        console.error(error);
        showError(error.message || "메시지 재번역 중 오류가 발생했습니다.");
    } finally {
        if (startedTranslation) {
            finishMessageTranslation(message, button);
        }

        addTranslateButtonsToMessages();
    }
}

// 자동 번역을 실행합니다.
// MutationObserver는 같은 메시지를 여러 번 감지할 수 있으므로 중복 실행을 막습니다.
async function autoTranslateMessage(messageBlock) {
    const context = getContext();
    const messageId = getMessageIdFromBlock(messageBlock);
    const message = messageId === null ? null : context.chat?.[messageId];

    if (!message || !shouldAutoTranslateMessage(message)) {
        return;
    }

    const tavagoData = getTavagoData(message);

    if (tavagoData.translated_text || tavagoData.auto_translate_started || tavagoData.translation_in_progress) {
        return;
    }

    tavagoData.auto_translate_started = true;

    setTimeout(async () => {
        const latestContext = getContext();
        const latestMessage = latestContext.chat?.[messageId];

        if (!latestMessage || !shouldAutoTranslateMessage(latestMessage)) {
            if (latestMessage) {
                getTavagoData(latestMessage).auto_translate_started = false;
            }

            return;
        }

        const latestTavagoData = getTavagoData(latestMessage);
        const button = $(messageBlock).find(`.${messageButtonClass}`).first();
        let startedTranslation = false;

        if (latestTavagoData.translated_text || latestTavagoData.translation_in_progress) {
            return;
        }

        if (!beginMessageTranslation(latestMessage, button)) {
            return;
        }

        startedTranslation = true;

        try {
            await translateAndSaveMessage(latestMessage);
            finishMessageTranslation(latestMessage, button);
            startedTranslation = false;
            await refreshMessageAndSave(latestContext, messageId, latestMessage);
        } catch (error) {
            latestTavagoData.auto_translate_started = false;
            markTranslationFailed(latestMessage, error);
            if (startedTranslation) {
                finishMessageTranslation(latestMessage, button);
                startedTranslation = false;
            }

            await refreshMessageAndSave(latestContext, messageId, latestMessage);
            console.error(error);
            showError(error.message || "자동 번역 중 오류가 발생했습니다.");
        } finally {
            if (startedTranslation) {
                finishMessageTranslation(latestMessage, button);
            }

            addTranslateButtonsToMessages();
        }
    }, autoTranslateDelayMs);
}

// 메시지 안에 있는 기존 SillyTavern 아이콘 버튼 영역을 찾습니다.
// Tavago 버튼은 펼쳐지는 extraMesButtons가 아니라 연필 아이콘 왼쪽 고정 영역에 넣습니다.
function findMessageButtonAnchor(messageBlock) {
    return messageBlock.querySelector(".mes_edit");
}

// 채팅 메시지 하나에 Tavago 아이콘 버튼을 추가합니다.
// 이미 버튼이 있으면 중복으로 만들지 않고 그냥 넘어갑니다.
function addTranslateButtonToMessage(messageBlock) {
    if (!(messageBlock instanceof HTMLElement)) {
        return;
    }

    if (messageBlock.querySelector(`.${messageButtonClass}`)) {
        return;
    }

    const messageId = getMessageIdFromBlock(messageBlock);

    if (messageId === null) {
        return;
    }

    const editButton = findMessageButtonAnchor(messageBlock);

    if (!editButton || !editButton.parentElement) {
        return;
    }

    const button = $(`
        <div class="${messageButtonClass} mes_button" title="Tavago로 이 메시지 번역">
            <span class="tavago-message-icon"></span>
        </div>
    `);
    let longPressTimer = null;
    let longPressHandled = false;

    const startLongPressTimer = function (event) {
        event.preventDefault();
        event.stopPropagation();
        longPressHandled = false;
        clearTimeout(longPressTimer);

        longPressTimer = setTimeout(async () => {
            longPressHandled = true;
            await retranslateMessage(messageBlock, button);
        }, longPressMs);
    };

    const finishShortPress = async function (event) {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(longPressTimer);

        if (longPressHandled) {
            return;
        }

        await toggleMessageTranslation(messageBlock, button);
    };

    const cancelPress = function () {
        clearTimeout(longPressTimer);
    };

    button.on("pointerdown", startLongPressTimer);
    button.on("pointerup", finishShortPress);
    button.on("pointerleave pointercancel", cancelPress);
    button.on("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
    });

    const context = getContext();
    const message = context.chat?.[messageId];

    if (message) {
        updateMessageButtonState(message, button);
    }

    editButton.parentElement.insertBefore(button[0], editButton);
}

// 화면에 보이는 모든 채팅 메시지에 Tavago 버튼을 붙입니다.
// allowAutoTranslate가 true일 때만 새 메시지 자동 번역도 같이 확인합니다.
function addTranslateButtonsToMessages(allowAutoTranslate = false) {
    document.querySelectorAll("#chat .mes").forEach((messageBlock) => {
        const messageId = getMessageIdFromBlock(messageBlock);
        const isNewMessage = messageId !== null && !seenMessageIds.has(messageId);

        addTranslateButtonToMessage(messageBlock);

        if (messageId !== null) {
            seenMessageIds.add(messageId);
        }

        if (allowAutoTranslate && isNewMessage) {
            autoTranslateMessage(messageBlock);
        }
    });
}

// 채팅 영역을 감시합니다.
// 새 메시지가 생기면 그 메시지에도 Tavago 버튼을 붙입니다.
function watchChatMessages() {
    const chat = document.querySelector("#chat");

    if (!chat) {
        return;
    }

    const observer = new MutationObserver(() => addTranslateButtonsToMessages(true));
    observer.observe(chat, { childList: true, subtree: true });
    addTranslateButtonsToMessages();
}

// 저장된 설정값을 설정창 화면에 채워 넣습니다.
function loadSettingsToUi() {
    const settings = getSettings();
    $("#tavago_target_language").val(settings.targetLanguage);
    $("#tavago_bidirectional_mode").val(settings.bidirectionalMode);
    $("#tavago_auto_translate_mode").val(settings.autoTranslateMode);
    $("#tavago_dual_line_mode").val(settings.dualLineMode ? "on" : "off");
    $("#tavago_custom_prompt").val(settings.customPrompt);
}

// 설정창의 입력 요소들을 Tavago 동작과 연결합니다.
// 설정을 바꾸면 SillyTavern 설정 저장 기능으로 자동 저장됩니다.
function bindSettingsEvents() {
    $("#tavago_target_language").on("change", function () {
        getSettings().targetLanguage = String($(this).val() || "ko");
        saveSettingsDebounced();
    });

    $("#tavago_bidirectional_mode").on("change", function () {
        getSettings().bidirectionalMode = String($(this).val() || "off");
        saveSettingsDebounced();
    });

    $("#tavago_auto_translate_mode").on("change", function () {
        getSettings().autoTranslateMode = String($(this).val() || "off");
        saveSettingsDebounced();
    });

    $("#tavago_dual_line_mode").on("change", function () {
        getSettings().dualLineMode = String($(this).val() || "off") === "on";
        saveSettingsDebounced();
    });

    $("#tavago_custom_prompt").on("input", function () {
        getSettings().customPrompt = String($(this).val() || "");
        saveSettingsDebounced();
    });
}

// Tavago 시작 지점입니다.
// SillyTavern 페이지 준비가 끝난 뒤 실행됩니다.
jQuery(async () => {
    getSettings();

    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);

    loadSettingsToUi();
    bindSettingsEvents();
    watchChatMessages();
    watchInputTranslateButton();
});
