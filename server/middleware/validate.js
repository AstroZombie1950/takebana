// Проверка тел запросов.
//
// Библиотеку не берём — по правилу проекта о новых зависимостях. Нужен разбор
// десятка типов и понятная ошибка, это помещается в один файл без транзитивных
// пакетов.
//
// Главное, ради чего это писалось, — типы. Тело приходит из JSON, где на месте
// строки может оказаться объект: `{"email": {"$ne": null}}` уходил прямиком
// в `User.findOne({ email })` и превращался в оператор Mongo. Проверки вида
// `if (!email)` такое пропускают: непустой объект истинный.
//
// Побочно закрывается перезапись лишними полями: в `req.body` остаётся только
// то, что описано в схеме, всё остальное отбрасывается.

const OBJECT_ID = /^[a-f\d]{24}$/i;
// Ключи трансляций — UUID, но схема допускает и произвольную строку; ограничиваем
// набор символов, потому что ключ участвует в пути к файлам сегментов.
const KEY = /^[\w-]{1,128}$/;
// Намеренно грубая: адрес всё равно проверяется только письмом, а строгая
// регулярка по RFC отсекает валидные адреса чаще, чем ловит опечатки.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const checks = {
    string(value) {
        if (typeof value !== 'string') return { error: 'ожидалась строка' };
        return { value };
    },
    email(value) {
        if (typeof value !== 'string') return { error: 'ожидалась строка' };
        if (value.length > 254) return { error: 'слишком длинный адрес' };
        if (!EMAIL.test(value)) return { error: 'не похоже на адрес почты' };
        return { value };
    },
    objectId(value) {
        if (typeof value !== 'string') return { error: 'ожидался идентификатор' };
        if (!OBJECT_ID.test(value)) return { error: 'некорректный идентификатор' };
        return { value };
    },
    key(value) {
        if (typeof value !== 'string') return { error: 'ожидался ключ' };
        if (!KEY.test(value)) return { error: 'некорректный ключ' };
        return { value };
    },
    // Числа приходят строками из форм multipart и числами из JSON — принимаем оба.
    int(value) {
        const n = typeof value === 'string' ? Number(value.trim()) : value;
        if (typeof n !== 'number' || !Number.isInteger(n)) return { error: 'ожидалось целое число' };
        return { value: n };
    },
    number(value) {
        const n = typeof value === 'string' ? Number(value.trim()) : value;
        if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'ожидалось число' };
        return { value: n };
    },
    bool(value) {
        if (typeof value === 'boolean') return { value };
        if (value === 'true' || value === '1') return { value: true };
        if (value === 'false' || value === '0') return { value: false };
        return { error: 'ожидалось да/нет' };
    },
    object(value, rule) {
        if (!isPlainObject(value)) return { error: 'ожидался объект' };
        const { clean, errors } = parseInto(rule.schema || {}, value);
        if (Object.keys(errors).length) return { nested: errors };
        return { value: clean };
    },
    array(value, rule) {
        if (!Array.isArray(value)) return { error: 'ожидался список' };
        if (rule.max !== undefined && value.length > rule.max) {
            return { error: `не больше ${rule.max} элементов` };
        }
        const out = [];
        const errors = {};
        value.forEach((item, i) => {
            const result = checkOne(`[${i}]`, rule.of || { type: 'string' }, item);
            if (result.error) errors[i] = result.error;
            else if (result.nested) Object.assign(errors, prefix(String(i), result.nested));
            else if (!result.skip) out.push(result.value);
        });
        if (Object.keys(errors).length) return { nested: errors };
        return { value: out };
    },
};

function prefix(name, errors) {
    const out = {};
    for (const key of Object.keys(errors)) out[`${name}.${key}`] = errors[key];
    return out;
}

function checkOne(name, rule, raw) {
    const type = rule.type || 'string';
    const check = checks[type];
    if (!check) throw new Error(`validate: неизвестный тип «${type}» у поля «${name}»`);

    // Поля multipart-форм приходят строками, в том числе те, что на самом деле
    // объекты и списки: часы работы, список уже загруженных фотографий. Раньше
    // их разбирал голый JSON.parse в обработчике — кривая строка означала 500.
    if (rule.json && typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            return { error: 'не разобрать JSON' };
        }
    }

    // Обрезаем до проверки формата, а не после: адрес с пробелами по краям
    // иначе не проходил бы регулярку и отбивался как «не похоже на адрес».
    if (typeof raw === 'string' && rule.trim !== false) raw = raw.trim();

    const result = check(raw, rule);
    if (result.error || result.nested) return result;
    const value = result.value;

    // Пустая строка после обрезки — это отсутствие значения, а не значение.
    if (value === '' && !rule.allowEmpty) {
        if (rule.required) return { error: 'обязательное поле' };
        return { skip: true };
    }

    if (typeof value === 'string') {
        if (rule.min !== undefined && value.length < rule.min) {
            return { error: `не короче ${rule.min} символов` };
        }
        if (rule.max !== undefined && value.length > rule.max) {
            return { error: `не длиннее ${rule.max} символов` };
        }
        if (rule.pattern && !rule.pattern.test(value)) return { error: 'недопустимое значение' };
    }

    if (typeof value === 'number') {
        if (rule.min !== undefined && value < rule.min) return { error: `не меньше ${rule.min}` };
        if (rule.max !== undefined && value > rule.max) return { error: `не больше ${rule.max}` };
    }

    if (rule.values && !rule.values.includes(value)) {
        return { error: `допустимо только: ${rule.values.join(', ')}` };
    }

    return { value };
}

function parseInto(schema, source) {
    const clean = {};
    const errors = {};

    for (const name of Object.keys(schema)) {
        const rule = schema[name];
        const raw = source[name];

        if (raw === undefined || raw === null) {
            if (rule.required) errors[name] = 'обязательное поле';
            else if (rule.default !== undefined) clean[name] = rule.default;
            continue;
        }

        const result = checkOne(name, rule, raw);
        if (result.error) errors[name] = result.error;
        else if (result.nested) Object.assign(errors, prefix(name, result.nested));
        else if (result.skip) {
            if (rule.default !== undefined) clean[name] = rule.default;
        } else clean[name] = result.value;
    }

    return { clean, errors };
}

// validate({ поле: { type, required, min, max, values, pattern, default, trim,
//                    allowEmpty, label, json, schema, of } })
//
// После успешной проверки req.body заменяется на разобранный объект: в нём
// только описанные поля, строки обрезаны, числа приведены к числам.
function validate(schema) {
    return function validateBody(req, res, next) {
        // multer при multipart без полей оставляет body пустым объектом, express.json
        // при пустом теле — тоже. А вот массив или строка сюда попасть не должны.
        if (!isPlainObject(req.body)) {
            return res.status(400).json({ message: 'Тело запроса должно быть объектом' });
        }

        const { clean, errors } = parseInto(schema, req.body);

        const failed = Object.keys(errors);
        if (failed.length) {
            // Страницы входа, регистрации и профиля показывают пользователю ровно
            // `message` из ответа, поэтому в него собирается человеческий текст,
            // а не общее «некорректные данные». Разбор по полям остаётся в `errors`.
            const message = failed
                .map((name) => {
                    const rule = schema[name.split('.')[0]] || {};
                    return `${rule.label || name}: ${errors[name]}`;
                })
                .join('; ');
            return res.status(400).json({ message, errors });
        }

        req.body = clean;
        next();
    };
}

module.exports = { validate };
