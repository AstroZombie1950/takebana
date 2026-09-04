const mongoose = require('mongoose');

const AdminSettingSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    value: {
        type: String,
        required: true
    }
});

module.exports = mongoose.model('AdminSetting', AdminSettingSchema);