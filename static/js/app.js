//
// SCRAMBLE.IO
//

//
// CONSTANTS
// See https://tools.ietf.org/html/rfc4880
//

var KEY_TYPE_RSA = 1
var KEY_SIZE = 2048

var ALGO_SHA1 = 2
var ALGO_AES128 = 7

var REGEX_TOKEN = /^[a-z0-9][a-z0-9][a-z0-9]+$/
var REGEX_EMAIL = /^([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,4})$/i
var REGEX_HASH_EMAIL = /^([A-F0-9]{40})@([A-Z0-9.-]+\.[A-Z]{2,4})$/i


//
// SESSION VARIABLES
//
// These are never seen by the server, and never go in cookies or localStorage
// sessionStorage["passKey"] is AES128 key derived from passphrase, used to encrypt to private key
// sessionStorage["privateKeyArmored"] is the plaintext private key, PGP ascii armored
//
// For convenience, we also have
// sessionStorage["pubHash"] +"@scramble.io" is the email of the logged-in user
//



//
// LOAD THE SITE
//

$(function(){
    if(!initPGP()) return
    bindKeyboardShortcuts()

    // are we logged in?
    var token = $.cookie("token")
    if(!token || !sessionStorage["passKey"]) {
        displayLogin()
    } else {
        loadDecryptAndDisplayInbox()
    }
})

// Renders a Handlebars template, reading from a <script> tag. Returns HTML.
function render(templateId, data) {
    var source = document.getElementById(templateId).textContent
    var template = Handlebars.compile(source)
    return template(data)
}



//
// CONTROLLER
//

function bindLoginEvents() {
    $("#enterButton").click(function(){
        var token = $("#token").val()
        var pass = $("#pass").val()
        login(token, pass)
    })

    var keys = null
    $("#generateButton").click(function(){
        showModal("create-account-template")

        setTimeout(function(){
            // create a new mailbox
            keys = openpgp.generate_key_pair(KEY_TYPE_RSA, KEY_SIZE, "")
            var publicHash = computePublicHash(keys.publicKeyArmored)
            var email = publicHash+"@"+window.location.hostname

            // Change "Generating..." to "Done", explain what's going on to the user
            $("#createAccountModal h3").text("Welcome, "+email)
            $("#spinner").css("display", "none")
            $("#createForm").css("display", "block")
        }, 100)

        $("#createButton").click(function(){
            createAccount(keys)
        })
    })
}

function bindSidebarEvents() {
    // Navigate to Inbox
    $("#tab-inbox").click(function(e){
        loadDecryptAndDisplayInbox()
    })
    
    // Navigate to Compose
    $("#tab-compose").click(function(e){
        displayCompose()
    })
    
    // Log out: click a link, deletes cookies and refreshes the page
    $("#link-logout").click(function(){
        $.removeCookie("token")
        $.removeCookie("passHash")
    })

    // Explain keyboard shortcuts
    $("#link-kb-shortcuts").click(function(){
        showModal("kb-shortcuts-template")
    })
}

function bindInboxEvents() {
    // Click on an email to open it
    $("#inbox li").click(function(e){
        readEmail($(e.target))
    })
}

function bindKeyboardShortcuts() {
    var currentKeyMap = keyMap
    $(document).keyup(function(e){
        // no keyboard shortcuts while the user is typing
        var tag = e.target.tagName.toLowerCase()
        if(tag=="textarea" ||
            (tag=="input" && e.target.type=="text") ||
            (tag=="input" && e.target.type=="password")){
            return
        }

        var code = e.which || e.charCode
        var mapping = currentKeyMap[code] || 
                      currentKeyMap[String.fromCharCode(code).toLowerCase()]
        if(!mapping){
            // unrecognized keyboard shortcut
            currentKeyMap = keyMap
        } else if (typeof(mapping)=="function"){
            // valid keyboard shortcut
            mapping()
            currentKeyMap = keyMap
        } else {
            // pressed one key in a combination, wait for the next key
            currentKeyMap = mapping
        }
    })
}
var keyMap = {
    "j":readNextEmail,
    "k":readPrevEmail,
    "g":{
        "i":loadDecryptAndDisplayInbox,
        "c":displayCompose,
        "s":function(){alert("Go to Sent Messages is still unimplemented")},
        "a":function(){alert("Go to Archive is stil unimplemented")}
    },
    "r":emailReply,
    "a":emailReplyAll,
    "f":emailForward,
    27:closeModal // esc key
}

function bindEmailEvents(email) {
    $("#replyButton").click(emailReply)
    $("#replyAllButton").click(emailReplyAll)
    $("#forwardButton").click(emailForward)
}

function bindComposeEvents() {
    $("#sendButton").click(function(){
        var subject = $("#subject").val()
        var to = $("#to").val()
        var body = $("#body").val()

        sendEmail(to, subject, body)
    })
}



//
// SIDEBAR
//

function setSelectedTab(tab) {
    $("#sidebar .tab").removeClass("selected")
    tab.addClass("selected")
}



//
// MODAL DIALOGS
//

function showModal(templateName){
    var modalHtml = render(templateName)
    $("#wrapper").append(modalHtml)
    $(".link-close-modal").click(closeModal)
}

function closeModal(){
    $(".modal").remove()
    $(".modal-bg").remove()
}



//
// LOGIN
//

function displayLogin(){
    $("#wrapper").html(render("login-template"))
    bindLoginEvents()
}

function login(token, pass){
    // two hashes of (token, pass)
    // ...one encrypts the private key. the server must never see it
    var keyHash = computeKeyHash(token, pass)
    var aes128Key = keyHash.substring(0,16)

    // save for this session only, never in a cookie or localStorage
    sessionStorage["passKey"] = aes128Key

    // ...the other one authenticates us
    var passHash = computePassHash(token, pass)

    // set cookies, try loading the inbox
    $.cookie("token", token) //, {"secure":true})
    $.cookie("passHash", passHash) //, {"secure":true})
    $.get("/inbox", function(inbox){
        decryptAndDisplayInbox(inbox)
    }, 'json').fail(function(){
        alert("Incorrect user or passphrase")
    })
}

// Generates a new PGP key pair. This takes a while.
function createKeys() {
    // create a new mailbox
    var keys = openpgp.generate_key_pair(KEY_TYPE_RSA, KEY_SIZE, "")
    var publicHash = computePublicHash(keys.publicKeyArmored)
    console.log("Creating "+publicHash+"@"+window.location.hostname)
}

// Attempts to creates a new account, given a freshly generated key pair.
// Reads token and passphrase. Validates that the token is unique, 
// and the passphrase strong enough.
// Posts the token, a hash of the passphrase, public key, and 
// encrypted private key to the server.
function createAccount(keys){
    var token = validateToken()
    if(token == null) return false
    var pass = validateNewPassword()
    if(pass == null) return false

    // two passphrase hashes, one for login and one to encrypt the private key
    // the server knows only the login hash, and must not know the private key
    var passHash = computePassHash(token, pass)
    var keyHash  = computeKeyHash(token, pass)

    // save for this session only, never in a cookie or localStorage
    sessionStorage["passKey"] = aes128Key
    sessionStorage["privateKeyArmored"] = keys.privateKeyArmored

    // encrypt the private key with the user's passphrase
    // first 16 bytes = 128 bits. the hash is binary, not actually "ASCII"
    var aes128Key = keyHash.substring(0,16); 
    var prefixRandom = openpgp_crypto_getPrefixRandom(ALGO_AES128)
    var cipherPrivateKey = openpgp_crypto_symmetricEncrypt(
        prefixRandom, ALGO_AES128, aes128Key, keys.privateKeyArmored)

    // send it
    var data = {
        token:token,
        passHash:passHash,
        publicKey:keys.publicKeyArmored,
        cipherPrivateKey:bin2hex(cipherPrivateKey)
    }
    $.post("/user/", data, function(){
        // set cookies, try loading the inbox
        $.cookie("token", token) //, {"secure":true})
        $.cookie("passHash", passHash) //, {"secure":true})
        $.get("/inbox", function(inbox){
            decryptAndDisplayInbox(inbox)
        }, 'json').fail(function(){
            alert("Try refreshing the page, then logging in.")
        })
    }).fail(function(xhr){
        alert(xhr.responseText)
    })
    
    return true
}

function computePublicHash(publicKeyArmored){
    return new jsSHA(publicKeyArmored, "ASCII").getHash("SHA-1", "HEX")
}

function computePassHash(token, pass){
    return new jsSHA("1"+token+pass, "ASCII").getHash("SHA-1", "HEX")
}

function computeKeyHash(token, pass){
    return new jsSHA("2"+token+pass, "ASCII").getHash("SHA-1", "ASCII")
}

function validateToken(){
    var token = $("#createToken").val()
    if(token.match(REGEX_TOKEN)) {
        return token
    } else {
        alert("User must be at least three letters and numbers.\n"
            + "No special characters.\n")
        return null
    }
}

function validateNewPassword(){
    var pass1 = $("#createPass").val()
    var pass2 = $("#confirmPass").val()
    if(pass1 != pass2){
        alert("Passphrases must match")
        return null
    }
    if(pass1.length < 10){
        alert("Your passphrase is too short.\n" + 
              "An ordinary password is not strong enough here.\n" +
              "For help, see http://xkcd.com/936/")
        return null
    }
    return pass1
}



//
// INBOX
//

function loadDecryptAndDisplayInbox(){
    $.get("/inbox", function(inbox){
        decryptAndDisplayInbox(inbox)
    }, 'json').fail(function(){
        displayLogin()
    })
}

function decryptAndDisplayInbox(inboxSummary){
    sessionStorage["pubHash"] = inboxSummary.PublicHash
    decryptPrivateKey(function(privateKey){
        decryptSubjects(inboxSummary.EmailHeaders, privateKey)
        var data = {
            token:        $.cookie("token"),
            pubHash:      inboxSummary.PublicHash,
            domain:       document.location.hostname,
            emailHeaders: inboxSummary.EmailHeaders
        }
        $("#wrapper").html(render("page-template", data))
        bindSidebarEvents()
        setSelectedTab($("#tab-inbox"))
        $("#inbox").html(render("inbox-template", data))
        bindInboxEvents()
    })
}

function decryptSubjects(headers, privateKey){
    for(var i = 0; i < headers.length; i++){
        var h = headers[i]
        try {
            h.Subject = decodePgp(h.CipherSubject, privateKey)
        } catch (fuu){
            h.Subject = "Decryption Failed"
        }
    }
}

function decryptPrivateKey(fn){
    if(sessionStorage["privateKeyArmored"]){
        var privateKey = openpgp.read_privateKey(sessionStorage["privateKeyArmored"])
        fn(privateKey)
        return
    }
    if(!sessionStorage["passKey"]){
        alert("Missing passphrase. Please log out and back in.")
        return
    }

    $.get("/user/me", function(cipherPrivateKeyHex){
        var cipherPrivateKey = hex2bin(cipherPrivateKeyHex)
        var privateKeyArmored = openpgp_crypto_symmetricDecrypt(
            ALGO_AES128, sessionStorage["passKey"], cipherPrivateKey)
        sessionStorage["privateKeyArmored"] = privateKeyArmored
        var privateKey = openpgp.read_privateKey(privateKeyArmored)
        fn(privateKey)
    }, "text").fail(function(xhr){
        alert("Failed to retrieve our own encrypted private key: "+xhr.responseText)
        return
    })
}
function decodePgp(armoredText, privateKey){
    var msgs = openpgp.read_message(armoredText)
    if(msgs.length != 1){
        alert("Warning. Expected 1 PGP message, found "+msgs.length)
    }
    var msg = msgs[0]
    if(msg.sessionKeys.length != 1){
        alert("Warning. Expected 1 PGP session key, found "+msg.sessionKeys.length)
    }
    if(privateKey.length != 1){
        alert("Warning. Expected 1 PGP private key, found "+privateKey.length)
    }
    var keymat = { key: privateKey[0], keymaterial: privateKey[0].privateKeyPacket}
    if(!keymat.keymaterial.decryptSecretMPIs("")){
        alert("Error. The private key is passphrase protected.")
    }
    var sessKey = msg.sessionKeys[0]
    var text = msg.decrypt(keymat, sessKey)
    return text
}

function readNextEmail(){
    var msg
    if($(".current").length == 0){
        msg = $("li").first()
    } else {
        msg = $(".current").next()
    }
    readEmail(msg)
}

function readPrevEmail(){
    var msg = $(".current").prev()
    if(msg.length > 0){
        readEmail(msg)
    }
}



//
// SINGLE EMAIL
//
var email = null

// Takes a subject-line <li>, selects it, shows the full email
function readEmail(target){
    if(target.size()==0) return
    $("li.current").removeClass("current")
    target.addClass("current")

    $.get("/email/"+target.data("id"), function(cipherBody){
        decryptPrivateKey(function(privateKey){
            var plaintextBody = decodePgp(cipherBody, privateKey)

            email = {
                from:        target.data("from"),
                to:          target.data("to"),
                toAddresses: target.data("to").split(",").map(trimToLower),
                subject:     target.text(),
                body:        plaintextBody
            }
            var html = render("email-template", email)
            $("#content").attr("class", "email").html(html)
            bindEmailEvents(email)
        })
    }, "text")
}

function emailReply(){
    if(!email) return
    displayCompose(email.from, email.subject, "")
}

function emailReplyAll(){
    if(!email) return
    var allRecipientsExceptMe = email.toAddresses.filter(function(addr){
        // email starts with our pubHash -> don't reply to our self
        return addr.indexOf(sessionStorage["pubHash"]) != 0
    }).concat([email.from])
    displayCompose(allRecipientsExceptMe.join(","), email.subject, "")
}

function emailForward(){
    if(!email) return
    displayCompose("", email.subject, email.body)
}




//
// COMPOSE
//
function displayCompose(to, subject, body){
    // clean up 
    $("#inbox").html("")
    email = null
    setSelectedTab($("#tab-compose"))

    // render compose form into #content
    var html = render("compose-template", {
        to:to,
        subject:subject,
        body:body
    })
    $("#content").attr("class", "compose").html(html)
    bindComposeEvents()
}

function sendEmail(to,subject,body){
    // send encrypted if possible
    var toAddresses = to.split(",").map(trimToLower)
    var invalidToAddresses = toAddresses.filter(function(addr){
        return !addr.match(REGEX_EMAIL)
    })
    if(invalidToAddresses.length>0){
        alert("Invalid email addresses "+invalidToAddresses.join(", "))
        return
    }

    var pubHashesArr = toAddresses.map(extractPubHash)
    var pubHashes = []
    var unencryptedToAddresses = []
    for(var i = 0; i < toAddresses.length; i++){
        if(pubHashesArr[i]){
            pubHashes.push(pubHashesArr[i])
        } else {
            unencryptedToAddresses.push(toAddresses[i])
        }
    }
    if(unencryptedToAddresses.length > 0){
        prompt("Sending to unencrypted addresses is not yet supported")
        return
    }

    // look up each recipient's public key
    pubHashes.forEach(function(pubHash){
        sendEmailEncrypted(to,subject,body,'inbox',pubHash)
    })

    // encrypt a copy to ourselves, for our outbox
    sendEmailEncrypted(to,subject,body,'sent',sessionStorage["pubHash"])
    return false
}

function sendEmailEncrypted(to,subject,body,box,pubHash){
    $.get("/user/"+pubHash, function(data){
        var publicKey = openpgp.read_publicKey(data)
        var cipherSubject = openpgp.write_encrypted_message(publicKey, subject)
        var cipherBody = openpgp.write_encrypted_message(publicKey, body)

        var data = {
            box: box,
            pubHash: pubHash,
            to: to,
            cipherSubject: cipherSubject,
            cipherBody: cipherBody
        }
        $.post("/email/", data, function(){
            displayCompose()
        }).fail(function(xhr){
            alert("Sending failed: "+xhr.responseText)
        })
    }).fail(function(){
        alert("Could not find public key for "+pubHash+"@...")
    })
}

function sendEmailUnencrypted(from, to, subject, body){
    alert("Unimplemented")
}

// Extracts the public-key hash from <public key hash>@<host>
// Return null if the email is not in that form
function extractPubHash(email){
    var match = REGEX_HASH_EMAIL.exec(email)
    if(match == null){
        return null
    }
    return match[1].toLowerCase()
}



//
// UTILITY
//

function initPGP(){
  if (window.crypto.getRandomValues) {
    openpgp.init()
    return true
  } else {
    window.alert("Sorry, you'll need a modern browser for this.\nUse Chrome >= 11, Safari >= 3.1 or Firefox >= 21")
    return false
  }   
}

function bin2hex(str){
    return util.hexstrdump(str)
}
function hex2bin(str){
    return util.hex2bin(str)
}
function trimToLower(str){
    return str.replace(/^\s+|\s+$/g,'').toLowerCase()
}
