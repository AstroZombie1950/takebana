// // REGISTER
// let openRegisterModal = document.getElementById('openModalButton');

// if (openRegisterModal) {
//     openRegisterModal.addEventListener('click', function() {
//         document.getElementById('modal').style.display = 'block';
//     });
// }

  
//   window.addEventListener('click', function(event) {
//     if (event.target == document.getElementById('modal')) {
//       document.getElementById('modal').style.display = 'none';
//     }
//   });
  

//   let registerFormButton = document.getElementById('registrationForm');

//   if (registerFormButton) {
//     registerFormButton.addEventListener('submit', function(event) {
//         event.preventDefault();
      
//         var email = document.getElementById('email').value;
//         var login = document.getElementById('login').value;
//         var password = document.getElementById('password').value;
      
//         fetch('/register', {
//           method: 'POST',
//           headers: {
//             'Content-Type': 'application/json'
//           },
//           body: JSON.stringify({
//             email: email,
//             login: login,
//             password: password
//           })
//         })
//         .then(response => response.json())
//         .then(data => {
//           if (data.message === 'User registered successfully') {
//             toast('User registered successfully');
//             document.getElementById('modal').style.display = 'none';
//           } else {
//             toast(data.message);
//           }
//         })
//         .catch(error => console.error('Error:', error));
//       });
//   }



// MORE BTN BIG MODAL
  // OPEN
let moreButton = document.querySelector('button.more'); 
let darkOverlay = document.querySelector('.dark_overlay');
let bigOverlay = document.querySelector('.dark_overlay .big_modal');
let lock = false;
if (moreButton) {
  moreButton.addEventListener('click', function() {
    darkOverlay.style.display = "block";
    setTimeout(() => {
      bigOverlay.classList.add('active');
      if (lock == false) {
        bigModalFunctions();
        lock = true;
      }
    }, 30);
  });
    // CLOSE 
  let closeBigModal = document.querySelector('.dark_overlay .big_modal .close');
  closeBigModal.addEventListener('click', function() {
    darkOverlay.style.display = "none";
    bigOverlay.classList.remove('active');
  });
}


// END MORE BTN BIG MODAL







function bigModalFunctions() {


// AUTO SLIDER 1
var sliderWrap = document.querySelector('.slider_wrap');
var items = document.querySelectorAll('.slider_wrap .item');
var itemWidth = items[0].clientWidth;
var offset = 0;
function slide() {
  offset += 0.3; // Скорость прокрутки
  if (offset >= itemWidth * 6 + 10 * 6) {
    offset = 0; // Возвращаем обратно
  }
  sliderWrap.style.transform = 'translateX(' + -offset + 'px)';
  requestAnimationFrame(slide); // Бесконечная анимация
}
slide();
// END AUTO SLIDER 1

// review SLIDER 1
var revSliderWrap = document.querySelector('.reviews .review_line[data-id="1"] .review_line_wrap');
var revItems = document.querySelectorAll('.reviews .review_line[data-id="1"] .item');
var revItemWidth = revItems[0].offsetWidth;
console.log(revItemWidth)
var revOffset = 0;
function revSlide() {
  revOffset += 0.1; // Скорость прокрутки
  if (revOffset >= revItemWidth * 6 + 8 * 6) {
    revOffset = 0; // Возвращаем обратно
  }
  revSliderWrap.style.transform = 'translateX(' + -revOffset + 'px)';
  requestAnimationFrame(revSlide); // Бесконечная анимация
}
revSlide();
// END review SLIDER 1

// review SLIDER 2
var rev2SliderWrap = document.querySelector('.reviews .review_line[data-id="2"] .review_line_wrap');
var rev2Items = document.querySelectorAll('.reviews .review_line[data-id="2"] .item');
var rev2ItemWidth = rev2Items[0].offsetWidth;
var rev2Offset = 0;
function rev2Slide() {
  rev2Offset += 0.2; // Скорость прокрутки
  if (rev2Offset >= rev2ItemWidth * 6 + 8 * 6) {
    rev2Offset = 0; // Возвращаем обратно
  }
  rev2SliderWrap.style.transform = 'translateX(' + -rev2Offset + 'px)';
  requestAnimationFrame(rev2Slide); // Бесконечная анимация
}
rev2Slide();
// END review SLIDER 2

// PHOTOS SLIDER 
  var slider = $('.bxslider').bxSlider({
    pager: true,
    infiniteLoop: false, // отключает бесконечный цикл
    auto: true, // включает автоматическую прокрутку
    pause: 5000, // устанавливает интервал автоматической прокрутки (в миллисекундах)
    onSliderLoad: function() {
      $('.bxslider').on("mouseover", function() { 
          slider.stopAuto(); // останавливает автоматическую прокрутку при взаимодействии
      });
      $('.bxslider').on("mouseout", function() { 
          slider.startAuto(); // возобновляет автоматическую прокрутку после взаимодействия
      });

      // Добавление класса 'inactive' к левой стрелке при загрузке слайдера
      $('.bx-controls-direction a.bx-prev').addClass('inactive');
    },
    onSlideBefore: function($slideElement, oldIndex, newIndex) {
        $('.bx-pager a').removeClass('active');
        $('.bx-pager a').eq(newIndex).addClass('active');
    },
    onSlideBefore: function($slideElement, oldIndex, newIndex) {
      $('.bx-pager a').removeClass('active');
      $('.bx-pager a').eq(newIndex).addClass('active');

      // Удаление класса 'inactive' со всех стрелок
      $('.bx-controls-direction a').removeClass('inactive');

      // Если это первый слайд, добавить класс 'inactive' к левой стрелке
      if(newIndex === 0) {
          $('.bx-controls-direction a.bx-prev').addClass('inactive');
      }
      // Если это последний слайд, добавить класс 'inactive' к правой стрелке
      else if(newIndex === slider.getSlideCount()-1) {
          $('.bx-controls-direction a.bx-next').addClass('inactive');
      }
    }
  });
// END PHOTOS SLIDER 

};
















// LOGIN 

// let openLoginModal = document.getElementById('openLoginModalButton');

// if (openLoginModal) {
//     openLoginModal.addEventListener('click', function() {
//         document.getElementById('loginModal').style.display = 'block';
//     });
// }

  
//   window.addEventListener('click', function(event) {
//     if (event.target == document.getElementById('loginModal')) {
//       document.getElementById('loginModal').style.display = 'none';
//     }
//   });
  

//   let loginFormbutton = document.getElementById('loginForm');

//   if (loginFormbutton) {
//     loginFormbutton.addEventListener('submit', function(event) {
//         event.preventDefault();
      
//         var email = document.getElementById('loginEmail').value;
//         var password = document.getElementById('loginPassword').value;
      
//         fetch('/login', {
//           method: 'POST',
//           headers: {
//             'Content-Type': 'application/json'
//           },
//           body: JSON.stringify({
//             email: email,
//             password: password
//           })
//         })
//         .then(response => response.json())
//         .then(data => {
//           if (data.message === 'User logged in successfully') {
//             toast('User logged in successfully');
//             document.getElementById('loginModal').style.display = 'none';
//           } else {
//             toast(data.message);
//           }
//         })
//         .catch(error => console.error('Error:', error));
//       });
//   }




// LOGOUT 

let logoutBtn = document.getElementById('logoutButton');
if (logoutBtn) {
    logoutBtn.addEventListener('click', function(event) {
        event.preventDefault();
      
        fetch('/logout', {
          method: 'POST',
        })
        .then(response => {
          if (response.ok) {
            toast('User logged out successfully');
            // Здесь вы можете обновить интерфейс пользователя, чтобы отразить состояние выхода из системы
          } else {
            toast('Error logging out, please try again', 'error');
          }
        })
        .catch(error => console.error('Error:', error));
      });
}










// MAIN PAGE TABS 

// let mainPageTubsBtns = document.querySelectorAll('.main_tabs button');
// let overlay = document.querySelector('.main_tabs .overlay');
// let blocked = true;
// let prevEl;
// mainPageTubsBtns.forEach((el) => {
//   el.addEventListener('click', function() {
//     mainPageTubsBtns.forEach((x) => {
//       if (x.classList.contains('active')) {
//         x.classList.remove('active');
//         prevEl = x;
//       }
//     });
    
//     el.classList.add('active');

//     if (el.getAttribute('data-id') == 1) {
//       overlay.classList.remove('active');
//     } else {
//       overlay.classList.add('active');
//     }

//     if (blocked) {
//       setTimeout(() => {
//         el.classList.remove('active');
//         prevEl.classList.add('active');
//         if (el.getAttribute('data-id') == 1) {
//           overlay.classList.add('active');
//         } else {
//           overlay.classList.remove('active');
//         }
//       }, 140);
      
//     }
//   }); 
// });

// END MAIN PAGE TABS
















// BIG MODAL BAR CLOSE ICON 
let bigBarModal = document.querySelector('.bigBarInfo');

if (bigBarModal) {
  bigBarModal.addEventListener('click', function(event) {
    console.log(event.target)
    if (event.target.classList.contains('close_img')) {
      bigBarModal.classList.remove('active');
    }
  });
}


// END BIG MODAL BAR CLOSE ICON 



// PROFILE BUTTON OPEN MODAL 
let profButton = document.querySelector('.map_header .info_panels .register .prof');
let profModal = document.querySelector('.profileInfo');
let closeProfModal = document.querySelector('.profileInfo .close_modal');
if (profButton) {
  profButton.addEventListener('click', function() {
    profModal.classList.add('active');
  });
  closeProfModal.addEventListener('click', function() {
    profModal.classList.remove('active');
  });
}

// END PROFILE BUTTON OPEN MODAL 




// SEARCH FOCUS FUNCTIONS 

  // Получите элементы
var searchDarkOverlay = document.querySelector('.map_dark_overlay');
var input = document.querySelector('.search_input input');
var clearInput = document.querySelector('.clear_input');

if (input) {
  // Добавьте обработчик события focus на поле ввода
  input.addEventListener('focus', function() {
    // Добавьте класс active к оверлею, когда поле ввода находится в фокусе
    searchDarkOverlay.classList.add('active');
  });

  input.addEventListener('blur', function() {
  // Удалите класс active с оверлея, когда поле ввода теряет фокус
  searchDarkOverlay.classList.remove('active');

  setTimeout(() => {
    var searchResults = document.querySelector('.search_results');
    searchResults.innerHTML = '';
    searchResults.classList.remove('active');
  }, 200)

  });

  // Добавьте обработчик события input на поле ввода
  input.addEventListener('input', function() {
    // Если в поле ввода есть хоть одна буква, добавьте класс active к картинке
    if (input.value.length > 0) {
        clearInput.classList.add('active');
    } else {
        clearInput.classList.remove('active');
    }
  });

  // Добавьте обработчик события click на картинку
  clearInput.addEventListener('click', function() {
    // Очистите поле ввода
    input.value = '';
    // Удалите класс active с картинки
    clearInput.classList.remove('active');
  });

  // Добавьте обработчик события input на поле ввода
  input.addEventListener('input', function() {
  // Если в поле ввода есть хоть одна буква, отправьте запрос на сервер
  if (input.value.length > 0) {
    fetch(`/searchEstablishments/${input.value}`)
        .then(response => response.json())
        .then(data => {
            console.log(data);

            // Получите элемент модального окна результатов поиска
            let searchResults = document.querySelector('.map_header .search_results');
            let searchPanel = document.querySelector('.map_header .search_panel');

            // Очистите модальное окно результатов поиска
            searchResults.innerHTML = '';

            // Если данные не пусты, добавьте класс active к модальному окну результатов поиска
            if (data.length > 0) {
                searchResults.classList.add('active');
                searchPanel.classList.add('active');
                // Для каждого заведения создайте элемент и добавьте его в модальное окно результатов поиска
                // Для каждого заведения создайте элемент и добавьте его в модальное окно результатов поиска
              data.forEach(function(establishment) {
                var item = document.createElement('div');
                item.classList.add('item');

                var name = document.createElement('p');
                name.textContent = establishment.name;

                var address = document.createElement('span');
                address.textContent = establishment.address;

                item.appendChild(name);
                item.appendChild(address);

                // Добавьте обработчик события click на элемент
                item.addEventListener('click', function() {
                  console.log('OPEN estate modal search')

                  fetch(`/getEstablishments/${establishment._id}`)
                      .then(response => response.json())
                      .then(data => {
                          // Получите элемент модального окна информации о заведении
                          var bigBarInfo = document.querySelector('.bigBarInfo');
              
                          // Заполните информацию о заведении
                          bigBarInfo.querySelector('.name').textContent = data.name;
                          bigBarInfo.querySelector('.description').textContent = data.address;
                          let open_till
                          if (localStorage.getItem('lang') == 'ru') {
                            open_till = 'Открыто до'
                          } else if (localStorage.getItem('lang') == 'en') {
                            open_till = 'Open till'
                          }
                                
                          document.querySelector('.bigBarInfo .time').innerText = `${open_till} ${data.weekdayHours.close}`;
              
                          // Проверьте, есть ли фотографии
                          // Получите все слайды
                          var slides = document.querySelectorAll('.photo_slider .slide');
                          // Если у заведения есть фотографии, обновите src каждого изображения и href каждого слайда
                          if (data.photos && data.photos.length > 0) {
                              for (var i = 0; i < slides.length; i++) {
                                  if (i < data.photos.length) {
                                      // Если у заведения есть фотография для этого слайда, обновите src и href
                                      slides[i].querySelector('img').src = data.photos[i];
                                      slides[i].href = data.photos[i];
                                  } else {
                                      // Если у заведения нет фотографии для этого слайда, оставьте src и href пустыми
                                      slides[i].querySelector('img').src = '';
                                      slides[i].href = '';
                                  }
                              }
                          } else {
                              // Если у заведения нет фотографий, оставьте src всех изображений и href всех слайдов пустыми
                              slides.forEach(slide => {
                                  slide.querySelector('img').src = '';
                                  slide.href = '';
                              });
                          }
              
                          // Проверьте статус online
                          var streamButton = document.querySelector('.stream_btn .btn');
                          let closeStreamButton = document.querySelector('.streamingFrame img');
                          streamButton.setAttribute('data-id', data._id);
                          streamButton.setAttribute('peer-id', data.peerId);
                          if (data.online) {
                              // Если заведение онлайн, покажите кнопку трансляции
                              streamButton.classList.add('active');

                              console.log('sos')
                              let watch
                              if (localStorage.getItem('lang') == 'ru') {
                                watch = 'Смотреть трансляцию'
                              } else if (localStorage.getItem('lang') == 'en') {
                                watch = 'Watch the broadcast'
                              }

                              streamButton.innerText = watch;
                          } else {
                            let watch
                              if (localStorage.getItem('lang') == 'ru') {
                                watch = 'Заведение оффлайн'
                              } else if (localStorage.getItem('lang') == 'en') {
                                watch = 'Offline establishment'
                              }

                              // Если заведение оффлайн, измените текст кнопки
                              streamButton.classList.remove('active');
                              streamButton.innerText = watch;
                          }

                          streamButton.addEventListener('click', function() {
                            console.log('подключаемся')
                            // Получаем идентификатор пира, к которому хотим подключиться
                            var another_peer_id = this.getAttribute('peer-id');
                            console.log('another peer');
                            console.log(another_peer_id)
                            var conn = peer.connect(another_peer_id);
                
                            conn.on('open', function() {
                              console.log('Connection established with: ' + another_peer_id);
                              conn.send('Hello from ' + peer_id + '!');
                            });
                            // Логируем полученные данные
                            conn.on('data', function(data) {
                              console.log('Received', data);
                            });
                          });



                          closeStreamButton.addEventListener('click', function() {
                            let streamFrame = document.querySelector('.streamingFrame');
                            let videoElement = document.querySelector('.streamingFrame video'); // Замените на класс вашего видеоэлемента
                            videoElement.srcObject.getTracks().forEach(track => track.stop());
                            streamFrame.classList.remove('active');
                            videoElement.srcObject = null;
                            // Отключитесь от пира
                            if (conn) {
                              conn.close();
                            }
                          });




              
                          // Получите все оценки для этого заведения
                          fetch(`/getRatings/${establishment._id}`)
                          .then(response => response.json())
                          .then(ratings => {
                              var averageRating = 0;
              
                              // Проверьте, есть ли оценки
                              if (ratings.length > 0) {
                                  // Вычислите средний рейтинг
                                  var totalRating = 0;
                                  ratings.forEach(rating => {
                                      totalRating += rating.rating;
                                  });
                                  averageRating = totalRating / ratings.length;
                              }
              
                              drawMiniStars(averageRating);
              
              
                              // Заполните модальное окно данными о рейтинге
                              document.querySelector('.bigBarInfo .rating_block .wrap p.rate').innerText = averageRating.toFixed(1);
              
                              let rating
                                          if (localStorage.getItem('lang') == 'ru') {
                                            rating = 'Оценок'
                                          } else if (localStorage.getItem('lang') == 'en') {
                                            rating = 'Rating'
                                          }
              
                              document.querySelector('.bigBarInfo .rating_block .wrap .stars_wrap p').innerText = `${ratings.length} ${rating}`;
              
                              // Заполните звезды в соответствии с рейтингом
                              var stars = document.querySelectorAll('.bigBarInfo .rating_block .wrap .stars .fa-star');
                              for (var i = 0; i < Math.round(averageRating); i++) {
                                  stars[i].classList.add('active');
                              }
                          });


                          // Проверьте, оценивал ли пользователь это заведение ранее
                          fetch(`/getUserRating/${userId}/${establishment._id}`)
                              .then(response => response.json())
                    .then(ratingData => {
                        if (ratingData) {


                          let rating
                            if (localStorage.getItem('lang') == 'ru') {
                              rating = 'Вы уже оценили это заведение!'
                            } else if (localStorage.getItem('lang') == 'en') {
                              rating = 'You have already rated this place!'
                            }
                            // Если пользователь уже оценивал это заведение, покажите сообщение
                            wrap.innerHTML = `<p class="done">${rating}</p>`;
                        } else {

                          let rating
                            if (localStorage.getItem('lang') == 'ru') {
                              rating = 'Оцените это место'
                            } else if (localStorage.getItem('lang') == 'en') {
                              rating = 'Rate this place'
                            }

                            // Если пользователь еще не оценивал это заведение, покажите звезды для оценки
                            wrap.innerHTML = `  <p>${rating}</p>
                            <div class="stars_vote">
                              <i class="fas fa-star"></i>
                              <i class="fas fa-star"></i>
                              <i class="fas fa-star"></i>
                              <i class="fas fa-star"></i>
                              <i class="fas fa-star"></i>
                            </div>`;
                            updateStars();
                        }
                    });
              
                          // Покажите модальное окно
                          bigBarInfo.classList.add('active');
                          var coordinates = ol.proj.fromLonLat([data.location.lng, data.location.lat]);
                          // Переместите центр карты к координатам заведения
                          map2.getView().setCenter(coordinates);
                          // Установите уровень приближения
                          map2.getView().setZoom(14);
                      });
              });

                searchResults.appendChild(item);
              });

            } else {
                searchResults.classList.remove('active');
                searchPanel.classList.remove('active');
            }
        });
  } else {
    // Если поле ввода пустое, очистите модальное окно результатов поиска и уберите класс active
    var searchResults = document.querySelector('.search_results');
    searchResults.innerHTML = '';
    searchResults.classList.remove('active');
    searchPanel.classList.remove('active');
  }
  });
}




// END SEARCH FOCUS FUNCTIONS 

































// MODAL EDIT MY ESATE 
var closeModal = document.querySelector('.head img');
var settingsOverlay = document.querySelector('.settingsOverlay');

// Находим элементы на странице
var settingsEstateSaveButton = document.querySelector('.estateSettings .buttons .btn');

if (settingsEstateSaveButton) {
  // Добавляем обработчик события клика на кнопку "Сохранить"
  settingsEstateSaveButton.addEventListener('click', function() {
    // Создаем объект FormData
    var data = new FormData();
    data.append('country', document.querySelector('.settingsOverlay .country').value);
    data.append('city', document.querySelector('.settingsOverlay .city').value);
    data.append('name', document.querySelector('.settingsOverlay .name').value);
    data.append('address', document.querySelector('.settingsOverlay .address').value);
    data.append('weekdayHours', JSON.stringify({
      open: document.querySelector('.settingsOverlay .weekdaysOpen').value,
      close: document.querySelector('.settingsOverlay .weekdaysClose').value
    }));
    data.append('weekendHours', JSON.stringify({
      open: document.querySelector('.settingsOverlay .weekendOpen').value,
      close: document.querySelector('.settingsOverlay .weekendClose').value
    }));

    // Добавляем URL-ы фотографий и файлы из filesArray в FormData
    var uploadedPhotos = filesArray.filter(f => f.url).map(f => f.url);
    var newPhotos = filesArray.filter(f => f.file).map(f => f.file);
    data.append('uploadedPhotos', JSON.stringify(uploadedPhotos));
    newPhotos.forEach(file => data.append('newPhotos', file));

    let id = localStorage.getItem('settingsEstate');

    // Отправляем данные на сервер
    fetch('/updateEstablishment/'+ id +'', {
      method: 'PUT',
      body: data
    })
    .then(response => response.json())
    .then(result => {
      console.log('Success:', result);
      toast('Success: The establishment has been updated successfully.'); // Change this line
    })
    .catch(error => {
      console.error('Error:', error);
      toast('Error: An error occurred while updating the establishment.', 'error'); // And this line
    });
  });

  // Добавляем обработчик события клика на img "close_modal_gray"
  closeModal.addEventListener('click', function() {
    // Удаляем класс 'active' у settingsOverlay
    settingsOverlay.classList.remove('active');

    // Очищаем поля ввода и превью фотографий
    inputs.forEach(function(input) {
      input.value = '';
    });
    preview.innerHTML = '';
    fileInput.value = '';
  });

}







// Находим элементы на странице
var editSpan = document.querySelector('.estateSettings .info .first span');
var inputs = document.querySelectorAll('.estateSettings .info input');
var removeSpan = document.querySelector('.estateSettings .remove_estate');


if (editSpan) {
  // Добавляем обработчик события клика на span "Изменить"
  editSpan.addEventListener('click', function() {
    // Переключаем класс 'blocked' на всех инпутах
    inputs.forEach(function(input) {
      input.classList.toggle('blocked');
    });
  });

  // Добавляем обработчик события клика на span "Удалить заведение"
  removeSpan.addEventListener('click', function() {
    // Здесь вы можете добавить код для отправки запроса на сервер
    // Например, вы можете использовать fetch или XMLHttpRequest
    // Вам потребуется ID заведения, который вы можете получить из данных страницы
  });
}


// END MODAL EDIT MY ESTATE



// PHOTO DROP 

var dropZone = document.getElementById('drop_zone');
var fileInput = document.getElementById('fileInput');
var preview = document.getElementById('preview');

if (dropZone) {
// Когда пользователь кликает на div, открывается окно выбора файлов
dropZone.addEventListener('click', function() {
  fileInput.click();
});

// Обработка перетаскивания файлов
dropZone.addEventListener('dragover', function(event) {
  event.stopPropagation();
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  dropZone.style.background = '#e8e8e8'; // Изменение фона при перетаскивании
});

dropZone.addEventListener('dragleave', function(event) {
  dropZone.style.background = ''; // Возвращение к исходному фону после перетаскивания
});

dropZone.addEventListener('drop', function(event) {
  event.stopPropagation();
  event.preventDefault();
  dropZone.style.background = ''; // Возвращение к исходному фону после перетаскивания
  var files = event.dataTransfer.files; // Получение файлов, которые были перетащены
  handleFiles(files);
});

fileInput.addEventListener('change', function(event) {
  var files = event.target.files; // Получение файлов, которые были выбраны
  handleFiles(files);
});

// function handleFiles(files) {
//   // Ограничение на максимум 6 файлов
//   var maxFiles = 6;
//   if (files.length > maxFiles) {
//     toast("Вы можете загрузить максимум " + maxFiles + " файлов. Будут загружены только первые " + maxFiles + " файлов.");
//     files = Array.prototype.slice.call(files, 0, maxFiles);
//   }

//   // Предварительный просмотр изображений
//   for (var i = 0; i < files.length; i++) {
//     var file = files[i];
//     var imageType = /^image\//;
//     if (!imageType.test(file.type)) {
//       continue;
//     }
//     var div = document.createElement("div");
//     div.classList.add("item");
//     var img = document.createElement("img");
//     img.classList.add("obj");
//     img.file = file;
//     img.height = 60; // Высота предварительного просмотра
//     div.appendChild(img);
//     preview.appendChild(div);
//     var reader = new FileReader();
//     reader.onload = (function(aImg) { return function(e) { aImg.src = e.target.result; }; })(img);
//     reader.readAsDataURL(file);
//   }
// }




var filesArray = [];

function handleFiles(files) {
  // Ограничение на максимум 6 файлов
  var maxFiles = 6;
  if (files.length > maxFiles) {
    toast("Вы можете загрузить максимум " + maxFiles + " файлов. Будут загружены только первые " + maxFiles + " файлов.");
    files = Array.prototype.slice.call(files, 0, maxFiles);
  }

  // Предварительный просмотр изображений
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var imageType = /^image\//;
    if (!imageType.test(file.type)) {
      continue;
    }
    var div = document.createElement("div");
    div.classList.add("item");
    var img = document.createElement("img");
    img.classList.add("obj");
    img.file = file;
    img.height = 60; // Высота предварительного просмотра
    div.appendChild(img);

    // Создаем кнопку удаления
    var removeBtn = document.createElement("button");
    removeBtn.textContent = "Удалить";
    removeBtn.dataset.id = file.name; // Используем имя файла в качестве уникального идентификатора
    removeBtn.addEventListener('click', function(e) {
      e.target.parentNode.remove(); // Удаляем div с изображением и кнопкой
      filesArray = filesArray.filter(f => f.id !== e.target.dataset.id);
    });
    div.appendChild(removeBtn);

    preview.appendChild(div);
    var reader = new FileReader();
    reader.onload = (function(aImg) { return function(e) { aImg.src = e.target.result; }; })(img);
    reader.readAsDataURL(file);

    // Добавляем файлы в filesArray
    filesArray.push({id: file.name, file: file});
  }
}





}


// END PHOTO DROP










