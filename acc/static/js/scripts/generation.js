const settings = require("./settings.js");
const gmail = require("./gmail.js");
const libsteam = require("./lib/libsteam.js");
const Generator = require("./lib/libgenerate.js").Generator;
const to = require("await-to-js").default;

function getEmail(accgen_email) {
    switch (settings.get("email_provider")) {
        case "accgen":
            return accgen_email;
        case "custom_domain":
            var custom_domain = settings.get("email_domain");
            if (custom_domain) {
                if (custom_domain.includes("@")) {
                    var email_split = custom_domain.toLowerCase().split("@");
                    return email_split[0].replace(/\./g, '') + "@" + email_split[1];
                } else
                    // Use the human like name generated by accgen backend
                    return accgen_email.split("@")[0] + "@" + custom_domain.toLowerCase();
            }
            return accgen_email;
        case "gmailv2":
        case "gmail":
            return settings.get("email_gmail");
        default:
            return accgen_email;
    }
}

async function getVerifyGmailv2() {
    var email = await gmail.waitForSteamEmail(false);
    if (!email)
        return { error: "No email received. Try running the gmail setup again." };
    return {
        creationid: email.split("newaccountverification?stoken=")[1].split("\n")[0].split("&creationid=")[1],
        verifylink: "https://store.steampowered.com/account/newaccountverification?stoken=" + email.split("newaccountverification?stoken=")[1].split("\n")[0]
    }
}

async function gmailV2DisableSteamGuard() {
    var email = await gmail.waitForSteamEmail(true);
    if (!email)
        return false;
    var disableLink = "https://store.steampowered.com/account/steamguarddisableverification?stoken=" +
        email.split("steamguarddisableverification?stoken=")[1].split("\n")[0];
    try {
        var res = await fetch(disableLink, {
            mode: "cors",
            credentials: "include",
            headers: {
                'Accept-Language': 'en-US',
            },
        })
        return res.ok && !(await res.text()).includes("Unable to disable Steam Guard!");
    } catch (error) {
        return false;
    }
}

async function accgen_handleReponse(err, res) {
    var response = libsteam.getBaseResponse();
    if (err)
        response.networkError();
    else if (!res.ok) {
        response.httpError(res.status);
        try {
            var json = await res.json();
            if (json.error)
                response.error.message = json.error;
            else
                console.error(json);
        } catch (error) {
            console.error(response);
        }
    }
    else {
        response.success = true;
        response.response = await res.json();
    }
    return response;
}

async function accgen_getData() {
    var [err, res] = await to(fetch("/userapi/generator/addtask", {
        method: "POST",
        body: JSON.stringify({
            step: "getdata"
        }),
        headers: {
            'Content-Type': 'application/json',
        },
    }));

    var ret = await accgen_handleReponse(err, res);
    if (ret.success)
        ret.response.email = getEmail(ret.response.email);
    return ret;
}

async function accgen_getVerify(email) {
    if (settings.get("email_provider") != "gmailv2") {
        var [err, res] = await to(fetch("/userapi/generator/addtask", {
            method: "POST",
            body: JSON.stringify({
                step: "getverify",
                email: email
            }),
            headers: {
                'Content-Type': 'application/json',
            },
        }));

        return accgen_handleReponse(err, res);
    }
    else {
        var email = await getVerifyGmailv2();
        var ret = libsteam.getBaseResponse();
        if (email.error) {
            ret.error.message = email.error;
        }
        else {
            ret.success = true;
            ret.response = email;
        }
        return ret;
    }
}

async function accgen_doAdditional(username, password, email, doSteamGuard, apps) {
    var [err, res] = await to(fetch("/userapi/generator/addtask", {
        method: "POST",
        body: JSON.stringify({
            step: "additional",
            username: username,
            password: password,
            email: email,
            doSteamGuard: doSteamGuard,
            // Signal to worker that it should not expect steam guard disable emails in it's inbox, since these are handled on the client
            // True with gmailv2
            noCheckInbox: settings.get("email_provider") == "gmailv2",
            activateApps: apps ? apps.map(a => parseInt(a)) : null,
            patreon: typeof additionalPatreonInfo !== "undefined" ? additionalPatreonInfo() : undefined
        }),
        headers: {
            'Content-Type': 'application/json',
        },
    }));
    if (doSteamGuard && settings.get("email_provider") == "gmailv2")
        if (!await gmailV2DisableSteamGuard())
            if (!await gmailV2DisableSteamGuard()) {
                var resp = libsteam.getBaseResponse();
                resp.error.message = "Failed to disable steam guard using GMail!";
                return resp;
            }

    return accgen_handleReponse(err, res);
}

exports.parseSteamError = function (code) {
    switch (code) {
        case 13:
            return {
                message: 'The email chosen by our system was invalid. Please Try again.',
            };
        case 14:
            return {
                message: 'The account name our system chose was not available. Please Try again.'
            };
        case 84:
            return {
                message: 'Steam is limitting account creations from your IP or this email address (if using Gmail). Try again later.',
                proxylimit: true
            };
        // Every request sent with an invalid captcha will result in error code 2
        case 2:
        case 101:
            return {
                message: 'Captcha solved incorrectly!'
            };
        case 105:
            return {
                message: "Your IP is banned by steam. Try disabling your VPN.",
                proxymessage: "Proxy IP banned by steam. Removed from proxy list.",
                proxyban: true
            };
        case 17:
            return {
                message: 'Steam has banned the domain. Please use Gmail or Custom domain',
                reportemail: true,
                cancel: true
            };
        default:
            return {
                message: `Error while creating the Steam account! Steam error code ${code}!`
            };
    }
}

// Gets called by libgenerate to check if it should stop mass-generation for whatever reason. Example: Banned IP when not using proxies, banned domain
function handleErrors(res, proxy) {
    if (!res.success) {
        if (res.error.steamerror) {
            var parsed = exports.parseSteamError(res.error.steamerror);
            if (parsed.cancel || (!proxy && (parsed.proxyban || parsed.proxylimit)))
                return "Generation stopped because of a previous error.";
            if (proxy) {
                if (parsed.proxyban) proxy.ban();
                if (parsed.proxylimit) proxy.ratelimit();
            }
        }
    }
    else
        if (proxy) proxy.verify();
    return false;
}

var generator = new Generator(libsteam.steam_getGid, libsteam.steam_requestVerify, libsteam.steam_verifyEmail, libsteam.steam_createAccount, accgen_getData, accgen_getVerify, accgen_doAdditional);
exports.generator = generator;

exports.generateAccounts = async function (count, captcha, multigen, statuscb, generationcallback, change_mass_gen_status, useproxy) {
    if (settings.get("email_provider") == "gmailv2")
        gmail.updateTimeStamp();
    var getProxy = null;
    if (useproxy)
        getProxy = (await import(/* webpackChunkName: "proxy" */ "./proxy.js")).getProxy;
    return await generator.generateAccounts(fetch, handleErrors, count, captcha, multigen, statuscb, generationcallback, change_mass_gen_status, { acc_steamguard: settings.get("acc_steamguard"), acc_apps: settings.get("acc_apps") }, getProxy);
}