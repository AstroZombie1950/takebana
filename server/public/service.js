// Обработчики страниц: профиль, карта, регистрация заведения.
//
// Вход и регистрация переехали в tk-auth.js, регистрация заведения —
// в tk-company.js, вместе с новой вёрсткой этих страниц: здесь они цеплялись
// за селекторы section.login / section.register / section.register_company,
// которых больше нет ни на одной странице.




// NAME ADD password UPDATE

const saveButton = document.querySelector('.profileInfo .save .btn');
if (saveButton) {
    saveButton.addEventListener('click', function(event) {
        event.preventDefault();
    
        const login = document.querySelector('.bio input').value;
        const oldPassword = document.querySelector('.profileInfo .old input').value;
        const newPassword = document.querySelector('.profileInfo .new .newPass').value;
        const confirmPassword = document.querySelector('.profileInfo .new input:last-child').value;


        // обновляем сразу буквы в окошке профиля 
        if (login) {
          let words = login.split(' ');
          let result = '';
      
          if (words.length >= 2) {
              // Если есть два или более слов, берем первую букву первого слова и первую букву второго слова
              result = words[0].charAt(0) + words[1].charAt(0);
          } else {
              // Если есть только одно слово, берем первые две буквы этого слова
              result = words[0].substring(0, 2);
          }
          let profileWords = document.querySelector('.map_header .info_panels .register .prof p');
          if (profileWords) {
            profileWords.innerHTML = result.toUpperCase();
          }
      
          console.log(result);
      }


        // If at least one password field is filled
        if (oldPassword || newPassword || confirmPassword) {
            // Check if all password fields are filled
            if (!oldPassword || !newPassword || !confirmPassword) {
                toast('Please fill all the password fields or clear them');
                return;
            }

            if (newPassword !== confirmPassword) {
                toast('Passwords do not match');
                return;
            }
        
            fetch('/update-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ oldPassword, newPassword }),
            })
            .then(response => response.json())
            .then(data => {
                if (data.message === 'Password updated successfully') {
                    toast('Password successfully updated!');
                } else {
                    toast(data.message);
                }
            })
            .catch((error) => {
                console.error('Error:', error);
            });
        } else {
            // If password fields are empty, update profile
            fetch('/update-profile', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ login }),
            })
            .then(response => response.json())
            .then(data => {
                if (data.message === 'Profile updated successfully') {
                    toast('Data successfully saved!');
                } else {
                    toast(data.message);
                }
            })
            .catch((error) => {
                console.error('Error:', error);
            });
        }
    });
}
  

// END CHANGE PASSWORD 







// SET RATING FROM USER 
var wrap = document.querySelector('.wrap_2');

if (wrap) {
  function updateStars() {
    var stars = document.querySelectorAll('.stars_vote .fa-star');
    
    var rating = 0;
  
    stars.forEach((star, index) => {
      star.addEventListener('mouseover', function() {
          resetStars();
          for (var i = 0; i <= index; i++) {
              stars[i].classList.add('active');
          }
      });
  
      star.addEventListener('click', function() {
          rating = index + 1;
  
          // Отправьте запрос на сервер с оценкой и идентификатором заведения
          fetch('/rateEstablishment', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify({establishmentId: currentEstablishmentId, rating: rating })
          })
          .then(response => response.json())
          .then(data => {

            let rating
            if (localStorage.getItem('lang') == 'ru') {
              rating = 'Спасибо, ваша оценка зачтена!'
            } else if (localStorage.getItem('lang') == 'en') {
              rating = 'Thank you, your assessment is credited!'
            }

              wrap.innerHTML = `<p>${rating}</p>`;
              wrap.querySelector('p').style.maxWidth = "180px";
          });
      });
    });
  
    wrap.addEventListener('mouseleave', function() {
        if (rating === 0) {
            resetStars();
        } else {
            for (var i = 0; i < rating; i++) {
                stars[i].classList.add('active');
            }
        }
    });
  
    function resetStars() {
        stars.forEach(star => {
            star.classList.remove('active');
        });
    }
  }
  
  // вызовите эту функцию после каждого обновления innerHTML
  updateStars();
  
}

// END SET RATING FROM USER 

















// MY ESTATES BUTTON 

// Найти кнопку и модальное окно по классу
var myEstatesBtn = document.querySelector('.myEstates');
var myEstatesModal = document.querySelector('.myEstablishments');

if (myEstatesModal && myEstatesBtn) {
  // Добавить обработчик событий для открытия модального окна
  myEstatesBtn.addEventListener('click', function() {
    
    myEstatesModal.classList.add("active");

    var establishmentsBlock = document.querySelector('.establishments');
    establishmentsBlock.innerHTML = "";
    fetch('/user-establishments', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(establishments => {
      establishments.forEach((establishment) => {
        // Получить рейтинги заведения
        fetch('/getRatings/' + establishment._id, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        })
        .then(response => response.json())
        .then(ratings => {
          // Вычислить средний рейтинг и количество оценок
          var totalRating = 0;
          ratings.forEach(rating => {
            totalRating += rating.rating;
          });
          var averageRating = ratings.length > 0 ? totalRating / ratings.length : 0;
          var ratingCount = ratings.length;
      
          // Определить статус онлайн/оффлайн
          var onlineStatus = establishment.online ? 'active' : '';
          var offlineStatus = establishment.online ? '' : 'active';
      

          let onl;
          let ofl;
          let rate;
          let open_till;
          let start;

          if (localStorage.getItem('lang') == 'ru') {
            onl = 'Онлайн'
            ofl = 'Оффлайн'
            rate = 'оценок'
            open_till = 'Открыто до'
            start = 'Запустить трансляцию'
          } else if (localStorage.getItem('lang') == 'en') {
            onl = 'Online'
            ofl = 'Offline'
            rate = 'rate'
            open_till = 'Open till'
            start = 'Start broadcasting'
          }



          // Добавить заведение на страницу
          var itemHTML = `
            <div class="item">
              <div class="head">
                <div class="online ${onlineStatus}">
                  <span>${onl}</span>
                </div>
                <div class="offline ${offlineStatus}">
                  <span>${ofl}</span>
                </div>
                <img class="settings" data-id="${establishment._id}" src="/img/settings.svg" alt="settings">
              </div>
              <div class="info">
                <p>${establishment.name}</p>
                <span>${establishment.address}</span>
                <div class="time_stars">
                  <p class="rating">${averageRating.toFixed(1)} <img src="/img/rating_star.svg" alt="rating"></p>
                  <p class="rating_count">${ratingCount} ${rate}</p>
                  <p class="opened">${open_till} ${establishment.weekdayHours.close}</p>
                </div>
              </div>
              <div class="foot">
                <button data-id="${establishment._id}" class="btn startStream">
                  <img src="/img/start.svg" alt="start">
                  ${start}
                </button>
              </div>
            </div>
          `;
      
          // Идентификатор шестерёнке — в самой разметке. Раньше он ставился
          // по индексу, а карточки дорисовываются в порядке прихода ответов:
          // индекс промахивался, падал TypeError, и шестерёнка могла открыть
          // настройки чужого заведения.
          establishmentsBlock.innerHTML += itemHTML;

          estateListeners()
          

        })
        .catch(error => console.error('Error:', error));
      });
     
        
    })
    .catch(error => console.error('Error:', error));
});




// Камера заведения (routes/venueLive.js): владелец вещает в закрытую комнату
// Daily, гости на карте смотрят. Раньше поток шёл через публичный PeerJS.
var venueLive = {};

function setBroadcastUi(btn, on) {
  var en = localStorage.getItem('lang') == 'en';
  var label = on ? (en ? 'Stop broadcasting' : 'Остановить трансляцию')
                 : (en ? 'Start broadcasting' : 'Запустить трансляцию');
  var head = btn.parentElement.parentElement;
  var offlineMark = head.querySelector('.myEstablishments .left-tab .item .head .offline');
  var onlineMark = head.querySelector('.myEstablishments .left-tab .item .head .online');
  btn.classList.toggle('active', on);
  btn.innerHTML = '<img src="/img/' + (on ? 'pause' : 'start') + '.svg" alt="">' + label;
  if (offlineMark) offlineMark.classList.toggle('active', !on);
  if (onlineMark) onlineMark.classList.toggle('active', on);
}

function startVenueLive(id, btn) {
  if (venueLive[id]) return;
  btn.disabled = true;
  TKDaily.requestAccess('/api/venues/' + id + '/live').then(function (first) {
    var firstAccess = first;
    venueLive[id] = TKDaily.connect({
      send: true,
      video: true,
      // Повторный вход после обрыва — через /watch: комнату не пересоздаём,
      // иначе обрыв у владельца выкидывал бы всех гостей.
      access: function () {
        if (!firstAccess) return TKDaily.requestAccess('/api/venues/' + id + '/watch');
        var a = firstAccess;
        firstAccess = null;
        return Promise.resolve(a);
      },
      onMediaError: function () {
        toast('Нет доступа к камере или микрофону — разрешите его в настройках браузера', 'error');
      },
      onState: function (s) {
        if (s === 'live') { btn.disabled = false; setBroadcastUi(btn, true); }
        if (s === 'ended') {
          toast('Трансляция прервалась: нет связи с сервисом видео', 'error');
          stopVenueLive(id, btn);
        }
      }
    });
  }).catch(function (err) {
    btn.disabled = false;
    toast(err.message, 'error');
  });
}

function stopVenueLive(id, btn) {
  var session = venueLive[id];
  delete venueLive[id];
  if (session) session.leave();
  btn.disabled = false;
  setBroadcastUi(btn, false);
  fetch('/api/venues/' + id + '/live', { method: 'DELETE' }).catch(function () {});
}

// Ушли со страницы с включённой камерой — гасим её на сервере, иначе
// заведение висело бы «онлайн» с пустой комнатой. Раньше здесь стоял
// beforeunload с preventDefault: диалог «Покинуть сайт?» получал каждый,
// кто уходил с карты, даже без всякой трансляции.
window.addEventListener('pagehide', function () {
  if (Object.keys(venueLive).length) navigator.sendBeacon('/updateEstablishmentsOnlineStatus');
});


function estateListeners() {

  // нажатие кнопок начала стрима 
  let startStreambtns = document.querySelectorAll('.startStream');
  startStreambtns.forEach((el) => {
    el.addEventListener('click', function() {
      this.classList.add('blocked');
      setTimeout(() => {
        this.classList.remove('blocked');
      }, 1000);

      const id = this.getAttribute('data-id');
      if (this.classList.contains('active')) stopVenueLive(id, this);
      else startVenueLive(id, this);
    });
  });
  


  // нажатие шестеренки 
  document.querySelectorAll('.item .settings').forEach(settingsIcon => {
    settingsIcon.addEventListener('click', function() {
      // Получить ID заведения из атрибута data-id
      var id = this.dataset.id;
      localStorage.setItem('settingsEstate', id);
  
      // Получить данные заведения с сервера
      fetch('/getEstablishments/' + id, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      .then(response => response.json())
      .then(establishment => {
        // Заполнить поля ввода данными из заведения
        document.querySelector('.settingsOverlay .country').value = establishment.country;
        document.querySelector('.settingsOverlay .city').value = establishment.city;
        document.querySelector('.settingsOverlay .name').value = establishment.name;
        document.querySelector('.settingsOverlay .address').value = establishment.address;
        document.querySelector('.settingsOverlay .weekdaysOpen').value = establishment.weekdayHours.open; // время открытия в будни
        document.querySelector('.settingsOverlay .weekdaysClose').value = establishment.weekdayHours.close; // время закрытия в будни
        document.querySelector('.settingsOverlay .weekendOpen').value = establishment.weekendHours.open; // время открытия в выходные
        document.querySelector('.settingsOverlay .weekendClose').value = establishment.weekendHours.close; // время закрытия в выходные
  
        // Отобразить фотографии заведения
        var preview = document.querySelector('#preview');
        preview.innerHTML = ''; // Очистить предыдущие изображения
        console.log(establishment)
        establishment.photos.forEach(photoUrl => {
          var img = document.createElement('img');
          img.src = photoUrl;
          img.classList.add('obj');
          var removeBtn = document.createElement('button');
          removeBtn.textContent = 'Удалить';
          removeBtn.dataset.id = photoUrl; // Используем URL фотографии в качестве уникального идентификатора
          removeBtn.addEventListener('click', function(e) {
            // Удаляем div с изображением и кнопкой
            e.target.parentNode.remove();
            // Удаляем фотографию из filesArray
            filesArray = filesArray.filter(f => f.id !== e.target.dataset.id);
          });
          var imgContainer = document.createElement('div');
          imgContainer.classList.add('item');
          imgContainer.appendChild(img);
          imgContainer.appendChild(removeBtn);
          preview.appendChild(imgContainer);
        
          // Добавляем фотографию в filesArray
          filesArray.push({id: photoUrl, url: photoUrl});
        });
        
     
  
        // Открыть модальное окно
        document.querySelector('.settingsOverlay').classList.add('active');
      })
      .catch(error => console.error('Error:', error));
    });
  });
}





  // Найти элемент для закрытия модального окна
  var closeEstateModal = document.querySelector('.myEstablishments .close_estateModal');

  if (closeEstateModal) {
    // Добавить обработчик событий для закрытия модального окна
    closeEstateModal.addEventListener('click', function() {
      myEstatesModal.classList.remove("active");
    });
  }


}


// END MY ESTATES BUTTON 








// GOOGLE BUTTON 

let googlebtn = document.querySelector('button.google');
if (googlebtn) {
  googlebtn.addEventListener('click', function() {
    window.location.href = '/auth/google';
  });
}




// db.createUser(
//   {
//     user: "admin",
//     pwd: "supressordelestado",
//     roles: [ { role: "readWrite", db: "webcabar" } ]
//   }
// )
