import moment from 'moment-timezone';

const profile = {
    birth: '1990-01-01',
    ianaTz: 'Asia/Omsk'
};

const birthMoment = moment.tz(profile.birth, profile.ianaTz); // ianaTz = 'Asia/Omsk'
const offset = birthMoment.format('Z'); // даст строку типа '+06:00'
const datetime_iso = `${birthMoment.format('YYYY-MM-DDTHH:mm:ss')}${offset}`;

console.log(datetime_iso);
