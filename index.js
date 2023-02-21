const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const {init: initDB, Counter} = require("./db");

const logger = morgan("tiny");
const request = require('request')

const app = express();
app.use(express.urlencoded({extended: false}));
app.use(express.json());
app.use(cors());
app.use(logger);

const configuration = new Configuration({
    apiKey: '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',
    basePath: 'http://43.153.15.174/v1'
});

const openai = new OpenAIApi(configuration);

async function getAIIMAGE(prompt) {
    const response = await openai.createImage({
        prompt: prompt,
        n: 1,
        size: '1024x1024',
    });

    const imageURL = response?.data?.data?.[0].url || 'AI 作画挂了';

    return imageURL;
}
// 首页
app.get("/", async (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数
app.post("/api/count", async (req, res) => {
    const {action} = req.body;
    if (action === "inc") {
        await Counter.create();
    } else if (action === "clear") {
        await Counter.destroy({
            truncate: true,
        });
    }
    res.send({
        code: 0,
        data: await Counter.count(),
    });
});

function sendmess(appid, mess) {
    return new Promise((resolve, reject) => {
        request({
            method: 'POST',
            url: `http://api.weixin.qq.com/cgi-bin/message/custom/send?from_appid=${appid}`,
            body: JSON.stringify(mess)
        }, function (error, response) {
            if (error) {
                console.log('接口返回错误', error)
                reject(error.toString())
            } else {
                console.log('接口返回内容', response.body)
                resolve(response.body)
            }
        })
    })
}

//需要有微信认证
app.post("/message/simple", async (req, res) => {
    console.log('消息推送', req.body)
    // 从 header 中取appid，如果 from-appid 不存在，则不是资源复用场景，可以直接传空字符串，使用环境所属账号发起云调用
    const appid = req.headers['x-wx-from-appid'] || ''
    const {ToUserName, FromUserName, MsgType, Content, CreateTime} = req.body
    console.log('推送接收的账号', ToUserName, '创建时间', CreateTime)
    if (MsgType === 'text') {
        if (Content === '回复文字') { // 小程序、公众号可用
            await sendmess(appid, {
                touser: FromUserName,
                msgtype: 'text',
                text: {
                    content: '这是回复的消息'
                }
            })
        }
        res.send('success')
    } else {
        res.send('success')
    }
})

async function buildCtxPrompt({FromUserName}) {
    // 获取最近对话
    const messages = await Message.findAll({
        where: {
            fromUser: FromUserName,
            aiType: AI_TYPE_TEXT,
        },
        limit: LIMIT_AI_TEXT_COUNT,
        order: [['updatedAt', 'ASC']],
    });
    // 只有一条的时候，就不用封装上下文了
    return messages.length === 1
        ? messages[0].request
        : messages
            .map(({response, request}) => `Q: ${request}\n A: ${response}`)
            .join('\n');
}
async function getAIResponse(prompt) {
    const completion = await openai.createCompletion({
        model: 'text-davinci-003',
        prompt,
        max_tokens: 1024,
        temperature: 0.1,
    });

    const response = (completion?.data?.choices?.[0].text || 'AI 挂了').trim();

    return strip(response, ['\n', 'A: ']);
}

// 获取 AI 回复消息
async function getAIMessage({Content, FromUserName}) {
    // 找一下，是否已有记录
    const message = await Message.findOne({
        where: {
            fromUser: FromUserName,
            request: Content,
        },
    });

    // 已回答，直接返回消息
    if (message?.status === MESSAGE_STATUS_ANSWERED) {
        return `${message?.response}`;
    }

    // 在回答中
    if (message?.status === MESSAGE_STATUS_THINKING) {
        return AI_THINKING_MESSAGE;
    }

    const aiType = Content.startsWith(AI_IMAGE_KEY)
        ? AI_TYPE_IMAGE
        : AI_TYPE_TEXT;


    // 没超过限制时，正常走AI链路
    // 因为AI响应比较慢，容易超时，先插入一条记录，维持状态，待后续更新记录。
    await Message.create({
        fromUser: FromUserName,
        response: '',
        request: Content,
        aiType,
    });

    let response = '';

    if (aiType === AI_TYPE_TEXT) {
        // 构建带上下文的 prompt
        const prompt = await buildCtxPrompt({Content, FromUserName});

        // 请求远程消息
        response = await getAIResponse(prompt);
    }

    if (aiType === AI_TYPE_IMAGE) {
        // 去掉开始前的关键词
        const prompt = Content.substring(AI_IMAGE_KEY.length);
        // 请求远程消息
        response = await getAIIMAGE(prompt);
    }

    // 成功后，更新记录
    await Message.update(
        {
            response: response,
            status: MESSAGE_STATUS_ANSWERED,
        },
        {
            where: {
                fromUser: FromUserName,
                request: Content,
            },
        },
    );

    return `${response}`;
}

app.post("/message/post", async (req, res) => {
    const {ToUserName, FromUserName, MsgType, Content, CreateTime} = req.body

    if (!FromUserName) {
        res.send({
            ToUserName: FromUserName,
            FromUserName: ToUserName,
            CreateTime: CreateTime,
            MsgType: 'text',
            Content: '无用户信息',
        })
        return;
    }

    if ((Content || '').trim() === '获取id') {
        res.send({
            ToUserName: FromUserName,
            FromUserName: ToUserName,
            CreateTime: CreateTime,
            MsgType: 'text',
            Content: FromUserName,
        })
        return;
    }

    if ((Content || '').startsWith(CLEAR_KEY)) {
        const clearType = Content.startsWith(CLEAR_KEY_IMAGE)
            ? AI_TYPE_IMAGE
            : AI_TYPE_TEXT;
        const FromUserName = Content.substring(CLEAR_KEY_TEXT.length);
        const count = await Message.destroy({
            where: {
                fromUser: FromUserName,
                aiType: {
                    [Op.or]: [clearType, null],
                },
            },
        });
        res.send({
            ToUserName: FromUserName,
            FromUserName: ToUserName,
            CreateTime: CreateTime,
            MsgType: 'text',
            Content: `已重置用户共 ${count} 条消息`,
        })
        return;
    }

    const message = await Promise.race([
        // 3秒微信服务器就会超时，超过2.8秒要提示用户重试
        sleep(2800).then(() => AI_THINKING_MESSAGE),
        getAIMessage({Content, FromUserName}),
    ]);
    console.log(message)
    res.send({
        ToUserName: FromUserName,
        FromUserName: ToUserName,
        CreateTime: +new Date(),
        MsgType: 'text',
        Content: message,
    })
})

// 获取计数
app.get("/api/count", async (req, res) => {
    const result = await Counter.count();
    res.send({
        code: 0,
        data: result,
    });
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
    if (req.headers["x-wx-source"]) {
        res.send(req.headers["x-wx-openid"]);
    }
});

const port = process.env.PORT || 80;

async function bootstrap() {
    await initDB();
    app.listen(port, () => {
        console.log("启动成功", port);
    });
}

bootstrap();
