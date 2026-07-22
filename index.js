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
const tavagoIconClass = "fa-solid fa-crow";
const longPressMs = 650;
const autoTranslateDelayMs = 1500;
const seenMessageIds = new Set();

// 처음 실행할 때 사용할 기본 설정입니다.
// 이미 저장된 설정이 있으면 getSettings()에서 이 값들과 합쳐집니다.
const defaultSettings = {
    targetLanguage: "Korean",
    autoTranslateMode: "ai",
    systemPrompt: [
        "You are Tavago, a precise translation engine.",
        "Translate the user's text into {{language}}.",
        "Preserve names, markdown, code blocks, and roleplay formatting.",
        "Return only the translated text.",
    ].join("\n"),
};

// SillyTavern에 저장된 Tavago 설정을 읽습니다.
// 빠진 값이 있으면 위의 기본 설정으로 채워줍니다.
function getSettings() {
    extension_settings[extensionName] = Object.assign(
        {},
        defaultSettings,
        extension_settings[extensionName] || {},
    );

    return extension_settings[extensionName];
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

    button.toggleClass(activeButtonClass, isShowingTranslation);

    if (!tavagoData.translated_text) {
        button.attr("title", "Tavago로 이 메시지 번역");
    } else if (isShowingTranslation) {
        button.attr("title", "원문 보기. 길게 누르면 재번역");
    } else {
        button.attr("title", "번역문 보기. 길게 누르면 재번역");
    }
}

// 현재 SillyTavern에 연결된 API/모델에게 번역을 요청합니다.
// Tavago는 별도 API 키를 받지 않고 generateRaw()를 사용합니다.
async function translateText(text) {
    const context = getContext();

    if (typeof context.generateRaw !== "function") {
        throw new Error("현재 SillyTavern에서 generateRaw()를 찾을 수 없습니다.");
    }

    const settings = getSettings();
    const systemPrompt = settings.systemPrompt.replaceAll("{{language}}", settings.targetLanguage);

    return await context.generateRaw({
        systemPrompt,
        prompt: text,
    });
}

// 아직 전송하지 않은 입력창 내용을 번역합니다.
// 입력창 내용은 저장된 채팅이 아니므로 실제 textarea 값을 바꿉니다.
async function translateInputTextarea() {
    const textarea = getInputTextarea();

    if (!(textarea instanceof HTMLTextAreaElement)) {
        showError("입력창을 찾지 못했습니다.");
        return;
    }

    const originalText = textarea.value.trim();

    if (!originalText) {
        showInfo("번역할 입력창 내용이 없습니다.");
        return;
    }

    const button = $("#tavago_translate_input");
    button.prop("disabled", true);
    button.addClass("tavago-busy");
    button.find("span").text("번역 중...");

    try {
        const translatedText = await translateText(originalText);
        textarea.value = translatedText.trim();
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        showInfo("입력창 번역이 완료되었습니다.");
    } catch (error) {
        console.error(error);
        showError(error.message || "번역 중 오류가 발생했습니다.");
    } finally {
        button.prop("disabled", false);
        button.removeClass("tavago-busy");
        button.find("span").text("입력창 번역");
    }
}

// 메시지를 새로 번역해서 Tavago 저장 공간에 넣습니다.
// forceRetranslate가 true면 기존 번역문이 있어도 API에 다시 요청합니다.
async function translateAndSaveMessage(message, forceRetranslate = false) {
    const tavagoData = getTavagoData(message);

    if (tavagoData.translated_text && !forceRetranslate) {
        showTranslation(message);
        return false;
    }

    const translatedText = await translateText(message.mes);
    tavagoData.translated_text = translatedText.trim();
    tavagoData.translated_at = Date.now();
    showTranslation(message);

    return true;
}

// 짧게 클릭했을 때 실행됩니다.
// 번역문이 없으면 번역하고, 이미 있으면 원문/번역문을 전환합니다.
async function toggleMessageTranslation(messageBlock, button) {
    const context = getContext();
    const messageId = getMessageIdFromBlock(messageBlock);
    const message = messageId === null ? null : context.chat?.[messageId];

    if (!message || !message.mes) {
        showError("번역할 메시지를 찾지 못했습니다.");
        return;
    }

    button.prop("disabled", true);
    button.addClass("tavago-busy");

    try {
        const tavagoData = getTavagoData(message);

        if (!hasSavedTranslation(message)) {
            await translateAndSaveMessage(message);
            showInfo("메시지 번역이 완료되었습니다.");
        } else if (tavagoData.showing_translation) {
            showOriginal(message);
        } else {
            showTranslation(message);
        }

        updateMessageButtonState(message, button);
        await refreshMessageAndSave(context, messageId, message);
    } catch (error) {
        console.error(error);
        showError(error.message || "메시지 번역 중 오류가 발생했습니다.");
    } finally {
        button.prop("disabled", false);
        button.removeClass("tavago-busy");
        addTranslateButtonsToMessages();
    }
}

// 길게 눌렀을 때 실행됩니다.
// 기존 번역문이 있어도 무시하고 새로 번역합니다.
async function retranslateMessage(messageBlock, button) {
    const context = getContext();
    const messageId = getMessageIdFromBlock(messageBlock);
    const message = messageId === null ? null : context.chat?.[messageId];

    if (!message || !message.mes) {
        showError("재번역할 메시지를 찾지 못했습니다.");
        return;
    }

    button.prop("disabled", true);
    button.addClass("tavago-busy");

    try {
        await translateAndSaveMessage(message, true);
        updateMessageButtonState(message, button);
        await refreshMessageAndSave(context, messageId, message);
        showInfo("메시지 재번역이 완료되었습니다.");
    } catch (error) {
        console.error(error);
        showError(error.message || "메시지 재번역 중 오류가 발생했습니다.");
    } finally {
        button.prop("disabled", false);
        button.removeClass("tavago-busy");
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

    if (tavagoData.translated_text || tavagoData.auto_translate_started) {
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

        if (latestTavagoData.translated_text) {
            return;
        }

        button.prop("disabled", true);
        button.addClass("tavago-busy");

        try {
            await translateAndSaveMessage(latestMessage);
            updateMessageButtonState(latestMessage, button);
            await refreshMessageAndSave(latestContext, messageId, latestMessage);
        } catch (error) {
            latestTavagoData.auto_translate_started = false;
            console.error(error);
            showError(error.message || "자동 번역 중 오류가 발생했습니다.");
        } finally {
            button.prop("disabled", false);
            button.removeClass("tavago-busy");
            addTranslateButtonsToMessages();
        }
    }, autoTranslateDelayMs);
}

// 메시지 안에 있는 기존 SillyTavern 아이콘 버튼 영역을 찾습니다.
// 버튼 영역을 못 찾으면 임시로 메시지 전체 영역에 버튼을 붙입니다.
function findMessageButtonContainer(messageBlock) {
    return (
        messageBlock.querySelector(".extraMesButtons") ||
        messageBlock.querySelector(".mes_buttons") ||
        messageBlock
    );
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

    const button = $(`
        <button class="${messageButtonClass} mes_button" title="Tavago로 이 메시지 번역">
            <i class="${tavagoIconClass}"></i>
        </button>
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

    findMessageButtonContainer(messageBlock).append(button[0]);
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
    $("#tavago_auto_translate_mode").val(settings.autoTranslateMode);
    $("#tavago_system_prompt").val(settings.systemPrompt);
}

// 설정창의 입력 요소들을 Tavago 동작과 연결합니다.
// 설정을 바꾸면 SillyTavern 설정 저장 기능으로 자동 저장됩니다.
function bindSettingsEvents() {
    $("#tavago_target_language").on("input", function () {
        getSettings().targetLanguage = String($(this).val() || "Korean").trim() || "Korean";
        saveSettingsDebounced();
    });

    $("#tavago_auto_translate_mode").on("change", function () {
        getSettings().autoTranslateMode = String($(this).val() || "off");
        saveSettingsDebounced();
    });

    $("#tavago_system_prompt").on("input", function () {
        getSettings().systemPrompt = String($(this).val() || defaultSettings.systemPrompt);
        saveSettingsDebounced();
    });

    $("#tavago_translate_input").on("click", translateInputTextarea);
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
});
